## Money in Space 2011

### the world's first orbiting museum

On August 17, 2011, the Russian-Ukrainian DNEPR launch vehicle placed the EduSAT microsatellite into orbit from the Yasny Space Center, carrying the artwork *Infra-TazebAu s’pace 2011. Information in Revolution. C.G.B. Satellite with Epistemological Propulsion. R.F.I.D. Shroud*. 21’37” by artist Paolo Monti.

The EduSAT program, funded and coordinated by the Italian Space Agency (ASI), aims to promote space-related scientific education among high school students and to support research and specialization activities for university students, doctoral candidates, and young researchers. It consists of a small-scale space mission designed to conduct scientific experiments and test new technologies in orbit, following a low-cost approach.

The microsatellite, built by students from the Astrodynamics Group at Sapienza University of Rome (GAUSS), features a square-based prismatic structure measuring 315 mm x 315 mm x 260 mm and weighs approximately 10 kg; it will be placed into a sun-synchronous polar orbit at an altitude of 700 km.

The rest of the story is at this link: https://www.paolomonti37788.it/money-in-space-2011-e/

This is my personal tribute to the artist and his work.

### Tech
D3.js (geoOrthographic) for projecting the globe onto a 2D Canvas—no WebGL, ensuring maximum compatibility.
satellite.js for orbital propagation (SGP4 algorithm), calculating satellite position and velocity based on a TLE.
Vanilla JavaScript, single self-contained HTML page (no backend).
Browser geolocation API for the "my location" button.
Position updates

### The satellite position
is not received in real-time; it is calculated every second using SGP4 based on a TLE (Two-Line Element set)—orbital parameters valid for a specific "epoch."

Where: A TLE is embedded in the page at the time of publication (fallback, available even offline).
When: Upon opening, the page attempts to download a more recent TLE from CelesTrak (celestrak.org), the standard public source based on US Combined Space Operations Center tracking data. If successful, it saves the TLE to the browser's localStorage for reuse; it checks again hourly and updates the data if it is older than 24 hours.
How: If the download fails (due to network issues or CORS), the page reverts to the last known valid TLE. The age and source of the active TLE are visible in the information panel ("live" = downloaded during the session, "offline" = embedded), and every attempt is logged to the console for verification.

#### Note: 
SGP4 accuracy degrades as the time elapsed since the TLE epoch increases—intervals of weeks or months can result in significant positional errors.
