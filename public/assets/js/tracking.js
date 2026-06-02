// LogicPals Legacy Tracking Wrapper
// Canonical tracker is /assets/js/lp-tracking.js

(function () {
  'use strict';

 window.dataLayer = window.dataLayer || [];

window.gtag = window.gtag || function () {
  window.dataLayer.push(arguments);
};

window.LP_track = function (eventName, params) {
  try {
    const cleanParams = params || {};

    // GTM custom event
    window.dataLayer.push(Object.assign({ event: eventName }, cleanParams));

    // GA4 direct event through gtag-compatible dataLayer command
    window.gtag('event', eventName, cleanParams);

    console.log('[LP Track]', eventName, cleanParams);
  } catch (e) {
    console.warn('[LP_track] failed:', eventName, e);
  }
};
})();