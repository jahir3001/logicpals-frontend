// LogicPals Event Tracking Layer (Enterprise-safe)

window.lpTrack = function (event, data = {}) {
  try {
    if (typeof fbq === "function") {
      fbq("track", event, data);
      console.log("[LP Track]", event, data);
    } else {
      console.warn("fbq not loaded");
    }
  } catch (err) {
    console.error("Tracking error:", err);
  }
};