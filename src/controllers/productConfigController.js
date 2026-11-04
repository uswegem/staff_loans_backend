'use strict';

const Settings = require('../models/Settings');
const audit = require('../services/audit/auditService');
const readiness = require('../services/products/configReadiness');
const { badRequest, conflict } = require('../utils/errors');

module.exports = {
  async report(req, res) {
    const [settings, detail] = await Promise.all([Settings.get(), readiness.report()]);
    res.json({ success: true, data: { enforcementEnabled: !!settings.productConfigEnforcementEnabled, ...detail } });
  },
  async activate(req, res) {
    const { enabled, confirmation } = req.body;
    const expected = enabled ? 'ACTIVATE_PRODUCT_CONFIG_ENFORCEMENT' : 'DEACTIVATE_PRODUCT_CONFIG_ENFORCEMENT';
    if (confirmation !== expected) throw badRequest('Provide the explicit activation or rollback confirmation phrase.', { confirmation: [expected] }, 'CONFIRMATION_REQUIRED');
    const current = await Settings.get();
    if (!!current.productConfigEnforcementEnabled === enabled) return res.json({ success: true, data: { enforcementEnabled: enabled, unchanged: true } });
    if (enabled) {
      const status = await readiness.report();
      if (status.incomplete) throw conflict('Configure and approve all live loan products before enabling enforcement.', 'PRODUCT_CONFIGURATION_INCOMPLETE', { products: status.products.filter((p) => !p.ready) });
    }
    const updated = await Settings.findOneAndUpdate(
      { _id: 'global', version: current.version },
      { $set: { productConfigEnforcementEnabled: enabled, updatedBy: req.auth.user._id }, $inc: { version: 1 } },
      { new: true }
    );
    if (!updated) throw conflict('Settings changed. Reload before activating.', 'SETTINGS_CHANGED');
    await audit.record({ req, action: 'products.enforcement', description: `Product configuration enforcement ${enabled ? 'enabled' : 'disabled'} by administrator`, entity: 'Settings', entityId: 'global', before: { productConfigEnforcementEnabled: !enabled }, after: { productConfigEnforcementEnabled: enabled } });
    return res.json({ success: true, data: { enforcementEnabled: enabled, settingsVersion: updated.version } });
  },
};
