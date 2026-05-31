/**
 * Post-Deployment Integration Tests: Followers API
 *
 * Main entry point that imports all followers test suites.
 *
 * ⚠️ CRITICAL: This test MUST NEVER run on production.
 * It will abort immediately if environment is not 'dev'.
 *
 * This test verifies:
 * - Following and unfollowing users and dogs
 * - Getting followers and following lists
 * - Checking follow status
 * - Getting follow counts
 * - Privacy controls (PUBLIC, FOLLOWERS, PRIVATE)
 * - Rate limiting
 * - Error handling (self-follow, duplicate follow, etc.)
 *
 * Prerequisites:
 * - ENVIRONMENT or DEPLOY_ENV must be set to 'dev'
 * - DATABASE_URL or DIRECT_DATABASE_URL must be set (or available via AWS SSM)
 * - SESSION_SECRET must be set (or available via AWS SSM)
 * - API must be running (via `npm run dev` or deployed)
 *
 * Usage:
 *   npm run test:postdeployment -- followers
 */

// Import all test suites
import "./follow.test.js";
import "./unfollow.test.js";
import "./following.test.js";
import "./followers.test.js";
import "./status.test.js";
import "./count.test.js";
import "./auth.test.js";
