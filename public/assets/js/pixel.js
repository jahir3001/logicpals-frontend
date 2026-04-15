// LogicPals — Meta Pixel (Centralized Tracking Layer)
// Version: v1 (Client-side only, server-side upgrade later)

// Prevent duplicate initialization
if (!window.__LP_PIXEL_LOADED__) {
  window.__LP_PIXEL_LOADED__ = true;

  (function(f,b,e,v,n,t,s){
    if(f.fbq)return;
    n=f.fbq=function(){n.callMethod?
    n.callMethod.apply(n,arguments):n.queue.push(arguments)};
    if(!f._fbq)f._fbq=n;
    n.push=n;
    n.loaded=!0;
    n.version='2.0';
    n.queue=[];
    t=b.createElement(e);
    t.async=!0;
    t.src=v;
    s=b.getElementsByTagName(e)[0];
    s.parentNode.insertBefore(t,s);
  })(window, document,'script',
  'https://connect.facebook.net/en_US/fbevents.js');

  // 🔴 INIT — your Pixel ID
  fbq('init', '1961788037810759');

  // 🔴 DEFAULT EVENT
  fbq('track', 'PageView');

  // 🔴 GLOBAL HELPER (future use)
  window.lpTrack = function(eventName, params = {}) {
    try {
      fbq('track', eventName, params);
    } catch (e) {
      console.warn('Pixel track error:', e);
    }
  };
}