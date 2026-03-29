/**
 * LOGICPALS TRACKING MODULE
 * Shared analytics helper — GTM dataLayer + Facebook Pixel
 *
 * SETUP:
 *   1. Replace GTM-XXXXXXX with your real GTM container ID in every HTML file
 *   2. Replace FB_PIXEL_PLACEHOLDER with your real Facebook Pixel ID in every HTML file
 *   3. This file provides window.LP_track() and window.LP_pixel() helpers
 *
 * GTM setup: Tags → New → GA4 Configuration (Measurement ID: G-XXXXXXXXXX, Trigger: All Pages)
 * FB Pixel:  Tags → New → Custom HTML (paste Pixel base code, Trigger: All Pages)
 *
 * Version: 1.0 — March 2026
 */

(function () {
  'use strict';

  // ── Initialise dataLayer ──────────────────────────────────────────────────
  window.dataLayer = window.dataLayer || [];

  /**
   * LP_track(eventName, params)
   * Wraps dataLayer.push — GTM forwards to GA4 automatically.
   *
   * Usage:
   *   window.LP_track('problem_completed', { track: 'olympiad', time_spent_seconds: 120 });
   */
  window.LP_track = function (eventName, params) {
    try {
      window.dataLayer.push(Object.assign({ event: eventName }, params || {}));
    } catch (e) {
      console.warn('[LP_track] failed:', eventName, e);
    }
  };

  /**
   * LP_pixel(eventName, params)
   * Fires a Facebook Pixel standard or custom event.
   * Safe no-op if Pixel not loaded.
   *
   * Usage:
   *   window.LP_pixel('Lead', { content_name: 'Free Trial Signup', currency: 'BDT', value: 0 });
   */
  window.LP_pixel = function (eventName, params) {
    try {
      if (typeof window.fbq === 'function') {
        window.fbq('track', eventName, params || {});
      }
    } catch (e) {
      console.warn('[LP_pixel] failed:', eventName, e);
    }
  };

  /**
   * LP_pixelCustom(eventName, params)
   * Fires a Facebook Pixel CUSTOM event.
   */
  window.LP_pixelCustom = function (eventName, params) {
    try {
      if (typeof window.fbq === 'function') {
        window.fbq('trackCustom', eventName, params || {});
      }
    } catch (e) {
      console.warn('[LP_pixelCustom] failed:', eventName, e);
    }
  };

})();
