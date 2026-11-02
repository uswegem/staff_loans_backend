'use strict';

// One-off data scripts: the name split (D-85) and the staff and products reset (D-92).

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

  it('stops on duplicate staff numbers before changing anything', () => {
    const file = path.join(os.tmpdir(), `slas-dupes-${process.pid}.csv`);
    fs.writeFileSync(file, 'First Name,Surname,Staff No,Gender,Department,Title\nA,B,AT1,Male,Credit,Officer\nC,D,AT1,Female,Credit,Officer\n');
    expect(() => reset.readStaff(file)).toThrow('Duplicate staff numbers, nothing changed: AT1');
    fs.rmSync(file, { force: true });
  });
});
