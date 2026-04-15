// LogicPals Event Tracking Layer

window.lpTrack = function (eventName, params = {}) {
  try {
    if (typeof fbq === 'function') {
      fbq('track', eventName, params);
      console.log('[LP Track]', eventName, params);
    } else {
      console.warn('fbq not loaded');
    }
  } catch (err) {
    console.error('Tracking error:', err);
  }
};