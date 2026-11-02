'use strict';

// One-off data scripts: the name split (D-85), the staff and products reset (D-92) and
// the staff loader (D-95).

const fs = require('fs');
const os = require('os');
const path = require('path');
const mongoose = require('mongoose');
const { seed, signIn } = require('../helpers');
const { seedProducts } = require('../fixtures/products');
const Staff = require('../../src/models/Staff');
const User = require('../../src/models/User');
const Role = require('../../src/models/Role');
const RoleAssignment = require('../../src/models/RoleAssignment');
const Product = require('../../src/models/Product');
const ProductVersion = require('../../src/models/ProductVersion');
const AuditLog = require('../../src/models/AuditLog');
const splitNames = require('../../scripts/split-names');
const reset = require('../../scripts/reset-staff-and-products');
const loadStaff = require('../../scripts/load-staff');

// A fictional staff table in the real format; the real one is not in the repository.
const EXAMPLE = path.join(__dirname, '..', '..', 'seed', 'data', 'lfb-staff.example.csv');

jest.setTimeout(240000);

describe('name split (D-85)', () => {
  it('splits next of kin names, folds middle names, logs the unclean ones, and is safe to run again', async () => {
    const col = mongoose.connection.db.collection('staffs');
    await col.insertMany([
      { staffNo: 'AT9001', firstName: 'Neema', middleName: 'Joyce', lastName: 'Mushi', nextOfKin: [{ name: 'Mwanaidi Ally Juma', relationship: 'Parent', phone: '+255 715 660 214' }] },
      { staffNo: 'AT9002', firstName: 'Bakari', lastName: 'Mfano', nextOfKin: [{ name: 'Rehema', relationship: 'Spouse', phone: '+255 715 660 215' }] },
    ]);
    const first = await splitNames.run(mongoose.connection.db);
    expect(first).toMatchObject({ staffFolded: 1, kinSplit: 2 });
    expect(first.unclean).toEqual([{ staffNo: 'AT9002', who: 'next of kin 1', name: 'Rehema', reason: 'only one word: no surname' }]);
    const neema = await col.findOne({ staffNo: 'AT9001' });
    expect(neema).toMatchObject({ firstName: 'Neema', lastName: 'Joyce Mushi' });
    expect(neema.middleName).toBeUndefined();
    expect(neema.nextOfKin[0]).toMatchObject({ firstName: 'Mwanaidi', lastName: 'Ally Juma', relationship: 'Parent' });
    expect(neema.nextOfKin[0].name).toBeUndefined();
    expect(await AuditLog.countDocuments({ action: 'data.split_names' })).toBe(1);

    const again = await splitNames.run(mongoose.connection.db);
    expect(again).toMatchObject({ staffFolded: 0, kinSplit: 0 });
    expect((await col.findOne({ staffNo: 'AT9001' })).lastName).toBe('Joyce Mushi');
  });

  it('displays "First Name Surname" for staff', async () => {
    await Staff.create({ staffNo: 'AT9003', firstName: 'Zawadi', lastName: 'Mfano', category: 'Non-management' });
    expect((await Staff.findOne({ staffNo: 'AT9003' })).fullName).toBe('Zawadi Mfano');
  });
});

describe('staff and products reset (D-92)', () => {
  const TEMP = 'Karibu#SLAS-2026x';
  beforeEach(async () => {
    const { users } = await seed();
    await seedProducts(users);
    process.env.RESET_TEMP_PASSWORD = TEMP;
  });
  afterEach(() => {
    delete process.env.RESET_TEMP_PASSWORD;
  });

  it('a dry run counts and changes nothing', async () => {
    const out = await reset.run({ dryRun: true, ownConnection: false, file: EXAMPLE });
    expect(out.dryRun).toBe(true);
    expect(out.plan.staffs).toBe(await Staff.countDocuments());
    expect(out.plan.products).toBe(4);
    expect(await Product.countDocuments()).toBe(4);
  });

  it('loads the staff table with roles, removes products, keeps an administrator login, and can run twice', async () => {
    const rows = reset.readStaff(EXAMPLE);
    const out = await reset.run({ ownConnection: false, file: EXAMPLE });
    expect(fs.existsSync(path.join(out.backupDir, 'staffs.json'))).toBe(true);
    expect(await Staff.countDocuments()).toBe(rows.length);
    expect(await Product.countDocuments()).toBe(0);
    expect(await ProductVersion.countDocuments()).toBe(0);
    expect(await User.countDocuments({ staffNo: /^LFB/ })).toBe(0);
    expect(out.odd.sort()).toEqual(['ATT38', 'ATT48', 'ATT53']);
    expect(out.admins).toEqual(['Amani Mfano (AT656)']);
    expect(Object.values(out.perDepartment).reduce((a, b) => a + b, 0)).toBe(rows.length);

    const admin = await User.findOne({ staffNo: 'AT656' });
    expect(admin.mustChangePassword).toBe(true);
    const codes = async (staffNo) => {
      const u = await User.findOne({ staffNo });
      const ids = (await RoleAssignment.find({ userId: u._id, revokedAt: null })).map((a) => a.roleId);
      return (await Role.find({ _id: { $in: ids } })).map((r) => r.code).sort();
    };
    expect(await codes('AT656')).toEqual(['staff', 'sys_admin']);
    expect(await codes('AT697')).toEqual(['head_credit', 'staff']);
    expect(await codes('AT727')).toEqual(['head_risk', 'staff']);
    // The administrator signs in with the temporary password and must change it.
    const session = await signIn('AT656', TEMP);
    expect(session.body.data.user.mustChangePassword).toBe(true);

    const second = await reset.run({ ownConnection: false, file: EXAMPLE });
    expect(second.loaded).toMatchObject({ created: 0, updated: rows.length, usersCreated: 0 });
    expect(second.deleted.staffs).toBe(0);
    expect(await Staff.countDocuments()).toBe(rows.length);
    expect(await codes('AT656')).toEqual(['staff', 'sys_admin']);
  });

  it('the staff loader adds new staff only, leaves existing records alone and is safe to run again (D-95)', async () => {
    // Four fictional staff with the titles of those added on 2 Nov 2026 (no role matches them).
    const file = path.join(os.tmpdir(), `slas-load-${process.pid}.csv`);
    fs.writeFileSync(
      file,
      `${fs.readFileSync(EXAMPLE, 'utf8').trimEnd()}\nBaraka,Mfano,AT961,Male,,Head of Operations\nDaudi,Mfano,AT962,Male,,Risk Lead\nElia,Mfano,AT963,Male,,AML and Compliance Business Partner\nFuraha,Mfano,AT964,Female,,Data Protection Officer\n`
    );
    await reset.run({ ownConnection: false, file: EXAMPLE });
    await Staff.updateOne({ staffNo: 'AT656' }, { $set: { title: 'Changed in the app by People and Culture' } });
    const staffBefore = await Staff.countDocuments();

    const dry = await loadStaff.run({ dryRun: true, ownConnection: false, file });
    expect(dry.toAdd).toEqual([
      'Baraka Mfano (AT961), Head of Operations',
      'Daudi Mfano (AT962), Risk Lead',
      'Elia Mfano (AT963), AML and Compliance Business Partner',
      'Furaha Mfano (AT964), Data Protection Officer',
    ]);
    expect(await Staff.countDocuments()).toBe(staffBefore);

    const first = await loadStaff.run({ ownConnection: false, file });
    expect(first.loaded).toMatchObject({ created: 4, usersCreated: 4 });
    // No role is guessed from these titles: Staff only.
    expect(first.noExtraRole).toEqual(['AT961 Head of Operations', 'AT962 Risk Lead', 'AT963 AML and Compliance Business Partner', 'AT964 Data Protection Officer']);
    const baraka = await Staff.findOne({ staffNo: 'AT961' }).lean();
    expect(baraka).toMatchObject({ firstName: 'Baraka', lastName: 'Mfano', gender: 'Male', title: 'Head of Operations', category: 'Management' });
    // Nothing is invented: no date of birth, NIDA or employment dates.
    expect(baraka.dateOfBirth?.value).toBeUndefined();
    expect(baraka.personal?.nida).toBeUndefined();
    expect(baraka.dateJoined).toBeUndefined();
    expect((await User.findOne({ staffNo: 'AT961' })).mustChangePassword).toBe(true);
    // Existing records are left as People and Culture keep them.
    expect((await Staff.findOne({ staffNo: 'AT656' })).title).toBe('Changed in the app by People and Culture');

    const second = await loadStaff.run({ ownConnection: false, file });
    expect(second.toAdd).toEqual([]);
    expect(await Staff.countDocuments({ staffNo: { $in: ['AT961', 'AT962', 'AT963', 'AT964'] } })).toBe(4);
    expect(await User.countDocuments({ staffNo: { $in: ['AT961', 'AT962', 'AT963', 'AT964'] } })).toBe(4);
    fs.rmSync(file, { force: true });
  });

  it('the staff loader stops, changing nothing, when a row lacks a required value', async () => {
    const file = path.join(os.tmpdir(), `slas-load-bad-${process.pid}.csv`);
    fs.writeFileSync(file, 'First Name,Surname,Staff No,Gender,Department,Title\nAmina,,AT950,Female,,Teller\n');
    await expect(loadStaff.run({ ownConnection: false, file })).rejects.toThrow('AT950: Surname is empty');
    expect(await Staff.countDocuments({ staffNo: 'AT950' })).toBe(0);
    fs.rmSync(file, { force: true });
  });

  it('stops on duplicate staff numbers before changing anything', () => {
    const file = path.join(os.tmpdir(), `slas-dupes-${process.pid}.csv`);
    fs.writeFileSync(file, 'First Name,Surname,Staff No,Gender,Department,Title\nA,B,AT1,Male,Credit,Officer\nC,D,AT1,Female,Credit,Officer\n');
    expect(() => reset.readStaff(file)).toThrow('Duplicate staff numbers, nothing changed: AT1');
    fs.rmSync(file, { force: true });
  });
});
