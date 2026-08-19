# Reorder drag debugging

The current issue is that the floating state ends after a short movement. Likely causes include pointer cancellation/lost capture or the delayed-drag cancellation handler still running after drag starts. The next implementation should make drag state authoritative after activation and only terminate on pointerup/pointercancel/lostpointercapture, while preventing page scrolling during active drag.
