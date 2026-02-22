const NOMINATIM_BASE_URL = "https://nominatim.openstreetmap.org/reverse";
const DEFAULT_TIMEOUT_MS = 8000;

const toNumber = (value) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
};

const formatAddressFromNominatim = (payload = {}) => {
  const addr = payload.address || {};
  const parts = [];

  if (typeof addr.building === "string" && addr.building.trim()) {
    parts.push(addr.building.trim());
  } else if (typeof addr.house_name === "string" && addr.house_name.trim()) {
    parts.push(addr.house_name.trim());
  } else if (typeof addr.house_number === "string" && addr.house_number.trim()) {
    parts.push(addr.house_number.trim());
  }

  if (typeof addr.road === "string" && addr.road.trim()) {
    parts.push(addr.road.trim());
  }

  const city =
    (typeof addr.city === "string" && addr.city.trim()) ||
    (typeof addr.town === "string" && addr.town.trim()) ||
    (typeof addr.village === "string" && addr.village.trim()) ||
    "";
  if (city) parts.push(city);

  if (typeof addr.state === "string" && addr.state.trim()) {
    const state = addr.state.trim();
    if (typeof addr.postcode === "string" && addr.postcode.trim()) {
      parts.push(`${state} - ${addr.postcode.trim()}`);
    } else {
      parts.push(state);
    }
  } else if (typeof addr.postcode === "string" && addr.postcode.trim()) {
    parts.push(addr.postcode.trim());
  }

  const assembled = parts.join(", ").trim();
  if (assembled) return assembled;

  if (typeof payload.display_name === "string" && payload.display_name.trim()) {
    return payload.display_name.trim();
  }

  return "";
};

exports.reverseGeocode = async (req, res) => {
  const latitude = toNumber(req.query.lat);
  const longitude = toNumber(req.query.lon);

  if (latitude === null || longitude === null) {
    return res.status(400).json({
      message: "lat and lon query params are required numeric values",
    });
  }

  if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    return res.status(400).json({
      message: "lat/lon are out of range",
    });
  }

  const qs = new URLSearchParams({
    format: "json",
    lat: String(latitude),
    lon: String(longitude),
    addressdetails: "1",
  });

  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    abortController.abort();
  }, DEFAULT_TIMEOUT_MS);

  try {
    const upstreamResponse = await fetch(`${NOMINATIM_BASE_URL}?${qs.toString()}`, {
      method: "GET",
      headers: {
        // Nominatim usage policy expects a clear identifying UA.
        "User-Agent":
          process.env.NOMINATIM_USER_AGENT ||
          "TerraCart/1.0 (contact: support@terracart.local)",
      },
      signal: abortController.signal,
    });

    if (!upstreamResponse.ok) {
      return res.status(502).json({
        message: "Reverse geocoding upstream request failed",
        status: upstreamResponse.status,
      });
    }

    const payload = await upstreamResponse.json();
    const formattedAddress = formatAddressFromNominatim(payload);

    return res.json({
      formattedAddress,
      displayName:
        typeof payload.display_name === "string" ? payload.display_name : "",
      address: payload.address || null,
      latitude,
      longitude,
    });
  } catch (error) {
    const isAbort = error?.name === "AbortError";
    return res.status(isAbort ? 504 : 500).json({
      message: isAbort ? "Reverse geocoding timeout" : "Reverse geocoding failed",
    });
  } finally {
    clearTimeout(timeout);
  }
};

