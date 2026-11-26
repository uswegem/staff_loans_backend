'use strict';

// D-111: a payslip may be at most 30 days old, counted from its pay date; Settings may set a
// shorter limit, never a longer one.

const { payslipProblem, payslipMaxAge, PAYSLIP_MAX_AGE_DAYS } = require('../../src/services/applications/rules');

const slip = (payDate) => ({ fileId: 'f1', payDate });

describe('payslip age (D-111)', () => {
  it('30 days old is accepted; 31 days old is refused', () => {
    expect(PAYSLIP_MAX_AGE_DAYS).toBe(30);
    expect(payslipProblem(slip('2026-10-27'), {}, '2026-11-26')).toBeNull();
    expect(payslipProblem(slip('2026-10-26'), {}, '2026-11-26')).toBe('Your payslip is dated 2026-10-26, 31 days ago. Attach one not older than 30 days.');
  });

  it('a shorter limit in Settings applies; a longer one counts as 30', () => {
    expect(payslipMaxAge({ payslipMaxAgeDays: 20 })).toBe(20);
    expect(payslipMaxAge({ payslipMaxAgeDays: 45 })).toBe(30);
    expect(payslipMaxAge({})).toBe(30);
    expect(payslipProblem(slip('2026-11-01'), { payslipMaxAgeDays: 20 }, '2026-11-26')).toMatch(/25 days ago\. Attach one not older than 20 days\.$/);
    expect(payslipProblem(slip('2026-10-20'), { payslipMaxAgeDays: 45 }, '2026-11-26')).toMatch(/37 days ago\. Attach one not older than 30 days\.$/);
  });
});
