/**
 * Playwright E2E Test: Dog Profile Image Upload
 *
 * This test verifies the complete flow of uploading a profile image to a dog profile:
 * 1. Authenticate user (via magic link or API)
 * 2. Create a dog profile
 * 3. Upload a profile image
 * 4. Update the dog profile with the image
 * 5. Verify the image is accessible and associated with the profile
 *
 * Prerequisites:
 * - Playwright browser automation infrastructure
 * - Maildummy infrastructure must be deployed (for magic link login)
 * - Frontend must be deployed and accessible
 * - Test image file must exist at apps/api/test/utils/testimage.png
 */

import { describe, it } from "vitest";

// SKIP: Requires Playwright browser automation infrastructure, maildummy S3 for
// email capture, and Flutter frontend. This test drives the Flutter web UI for
// image upload flows. Cannot run in vitest node environment.
describe.skip("Dog Profile Image Upload E2E", () => {
  it("should upload profile image and associate with dog profile", () => {
    // Requires Playwright page context with Flutter web app and maildummy infrastructure
  });
});
