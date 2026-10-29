'use strict';

const express = require('express');
const { authenticate } = require('../../middleware/auth');

const router = express.Router();

router.get('/health', (req, res) => res.json({ success: true, data: { status: 'ok' } }));
router.use('/auth', require('./auth'));

// Everything below needs a signed-in user.
router.use(authenticate);
router.use('/users', require('./users'));
router.use('/notifications', require('./notifications'));
router.use('/', require('./products'));
router.use('/', require('./roles'));
router.use('/', require('./admin'));

module.exports = router;
