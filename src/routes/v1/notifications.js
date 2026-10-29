'use strict';

const express = require('express');
const Joi = require('joi');
const NotificationController = require('../../controllers/notificationController');
const { validate } = require('../../middleware/validate');
const { asyncHandler } = require('../../utils/errors');

const router = express.Router();

/**
 * @openapi
 * /notifications:
 *   get: { tags: [Notifications], summary: "My in-app notifications (BRD 12)", security: [{ bearer: [] }], responses: { 200: { description: Items and unread count } } }
 * /notifications/unread-count:
 *   get: { tags: [Notifications], summary: "Unread count for the bell", security: [{ bearer: [] }], responses: { 200: { description: Count } } }
 * /notifications/{id}/read:
 *   post: { tags: [Notifications], summary: "Mark one as read", security: [{ bearer: [] }], responses: { 200: { description: Notification } } }
 * /notifications/read-all:
 *   post: { tags: [Notifications], summary: "Mark all as read", security: [{ bearer: [] }], responses: { 200: { description: OK } } }
 */
router.get('/', validate({ query: Joi.object({ unread: Joi.boolean(), limit: Joi.number().integer().min(1).max(100).default(30) }) }), asyncHandler(NotificationController.list));
router.get('/unread-count', asyncHandler(NotificationController.unreadCount));
router.post('/read-all', asyncHandler(NotificationController.markAllRead));
router.post('/:id/read', validate({ params: Joi.object({ id: Joi.string().hex().length(24).required() }) }), asyncHandler(NotificationController.markRead));

module.exports = router;
