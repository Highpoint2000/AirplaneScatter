# Airplane Scatter
Predicts and visualizes real-time airplane scatter opportunities for FM radio reception by combining live ADS-B flight tracking with transmitter databases and elevation profiles.

<img width="2000" height="836" alt="grafik" src="https://github.com/user-attachments/assets/72607b3a-b034-40a6-ae90-551c11e016bd" />
<img width="500" height="460" alt="grafik" src="https://github.com/user-attachments/assets/4c24cf61-60cf-43ca-954e-55868b6344b7" />
<img width="310" height="440" alt="grafik" src="https://github.com/user-attachments/assets/59e1bb3d-b202-4b7d-958d-3106a321d547" />

## Version 2.1 (Only compatible with FM DX Webserver version 1.4.0 and above !!!)

- The TX data from maps.fmdx.org is now loaded directly from RAM, taking over the DB download from tx_search.js
- Sweet Spot indicates the optimal altitude range in which an aircraft must be for Airplane Scatter to function ideally simultaneously from both TX and RX
- Problem during ERP migration resolved
- Elevation profile hover tooltip — new function initProfileCanvasHover() added; shows on mouse-over of the elevation canvas:
  + Distance from RX / TX at cursor position
  + Terrain height at cursor (interpolated)
  + Elevation angle from RX to terrain at cursor (red)
  + Elevation angle from TX to terrain at cursor (yellow)
  + Per-aircraft elevation angles from RX and TX (if aircraft is within ±30 km of cursor)

## Installation notes

1. [Download](https://github.com/Highpoint2000/AirplaneScatter/releases) the last repository as a zip
2. Unpack all files from the folder to ..fm-dx-webserver-main\plugins\ 
3. Stop or close the fm-dx-webserver
4. Start/Restart the fm-dx-webserver with "npm run webserver" on node.js console, check the console informations
5. Activate the sysinfo plugin in the settings
6. Stop or close the fm-dx-webserver
7. Start/Restart the fm-dx-webserver with "npm run webserver" on node.js console, check the console informations (for patching tx_search.js)
8. Stop or close the fm-dx-webserver
9. Start/Restart the fm-dx-webserver with "npm run webserver" on node.js console, check the console informations 
10. Reload the browser

## How to use
                                         
- Please read the Quick Reference Document
- For more details - please refer to the documentation: https://highpoint.fmdx.org/manuals/AirplaneScatter-Documentation.html
- Here's a demo video showcasing the plugin's functionalities: https://highpoint.fmdx.org/videos/AirplaneScatter-Demo.mp4
- For equalizing/denoising the audio signals in scatter mode, the use of the AI ​​Denoiser is recommended: https://github.com/Highpoint2000/AI-Denoise
- To decode RDS as quickly as possible during short-term receptions, the use of the RDS AI decoder is recommended: https://github.com/Highpoint2000/RDS-AI-Decoder

## Blacklist and Whitelist Options

To exclude locally used frequencies, the plugin offers a blacklist and whitelist function. The required TXT files must be located in the plugin folder (sample files are included in the current plugin package). In the "whitelist.txt" file, you can store frequencies (e.g., 89.800, 89.400, 100.80) that should be considered exclusively during processing. In the "blacklist.txt" file, you define frequencies that should be excluded from processing. You can configure which filter list should be active in the plugin settings.

## Contact

If you have any questions, would like to report problems, or have suggestions for improvement, please feel free to contact me! You can reach me by email at highpoint2000@googlemail.com. I look forward to hearing from you!

<a href="https://www.buymeacoffee.com/Highpoint" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height: 60px !important;width: 217px !important;" ></a>

<details>
<summary>History</summary>

### Version 2.0 (Only compatible with FM DX Webserver version 1.4.0 and above !!!)

- Local Node Proxy Server (airplanescatter_server.js) — replaces the unreliable public CORS proxy with a dedicated backend that runs inside FM-DX-Webserver
- Audio Stream Integration — Play/Stop buttons in the TX detail panel stream live web radio directly in the browser 
- Aircraft Category Filter — new setting to exclude smaller aircraft objects 
- Frequency Blacklist / Whitelist — static blacklist.txt / whitelist.txt files can be loaded to suppress or exclusively show specific frequencies
- The fetch radius (TX & aircraft) is extended to up to 1000 km
- The purple coverage area between RX and TX is now also displayed in the map line

### Version 1.1

- PST Rotator Integration: Live rotor azimuth tracking via WebSocket
- Auto-Sync Locks: New buttons (🔓/🔒) to automatically lock filters to your physical antenna heading and active radio frequency
- Click-to-Turn Rotor: Click a station's azimuth in the details panel to automatically turn your rotor (requires Admin/Tune)
- Multi-Select Compass: You can now click multiple compass directions simultaneously to combine filters
- Smart Sector Tracking: When locked to the rotor, the compass automatically filters both adjacent sectors if the antenna points between them
- Persistent Filters: Opening a station's elevation profile no longer resets your active background filters
- Smart Clear Button: Clicking the "Filtered by..." status text now smartly closes either just the active station view, or clears all filters if no station is open
- Anti-Stutter Optimization: Massive CPU improvements (bounding-box pre-filtering & CPU yielding) prevent browser lockups and audio stuttering on low-end hardware (e.g., Linux SBCs)

### Version 1.0

- Real-time scatter prediction – Continuously evaluates all aircraft against all FM transmitters and predicts scatter events up to 3 minutes in advance with a live ETA countdown
- Multi-factor scatter score (0–100%) – Weighted composite of cross-track distance, reflection geometry, aircraft altitude, fuselage alignment, transmitter ERP, and FM frequency — scaled by aircraft size category
- Interactive Leaflet map – Draggable, resizable floating panel with aircraft icons, TX dots, dashed scatter path lines, compass filter, and frequency filter; all colour-coded by score
- Topographic elevation profile – Interactive RX→TX terrain cross-section with LOS ceiling curves, scatter zone (purple), and live aircraft dot positions; zoomable and pannable
- Persistent crossing tracker – Once a candidate is detected it stays visible through approach, peak (NOW ✓), and recession, smoothly updated by dead reckoning between 15-second ADS-B fetches
- TX database integration – Loads all FM transmitters within 750 km radius (≥ 100 kW ERP) from maps.fmdx.org with 24-hour local cache and automatic invalidation on location drift
- ADS-B triple-source failover – Queries adsb.one → adsb.lol → adsb.fi automatically; remembers the last working source and uses it preferentially on the next cycle
- One-click receiver tuning – Clicking any frequency in the TX detail panel sends a tune command over the FM-DX-Webserver WebSocket, instantly retuning the receiver to the target frequency
- GPS WebSocket integration – Receives live GPS position from the FM-DX-Webserver data feed; falls back gracefully to manually configured QTH coordinates
- Compass & frequency filters – Eight-direction compass rose restricts candidates to a 45° bearing sector; frequency input simultaneously filters the map and tunes the receiver


