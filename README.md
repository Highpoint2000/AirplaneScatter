# Airplane Scutter
Predicts and visualizes real-time airplane scatter opportunities for FM radio reception by combining live ADS-B flight tracking with transmitter databases and elevation profiles.

<img width="1224" height="849" alt="grafik" src="https://github.com/user-attachments/assets/936e4701-af1a-42b5-bdec-0706c87451d2" />


## Version 1.0

- Real-time scatter prediction – Continuously evaluates all aircraft against all FM transmitters and predicts scatter events up to 3 minutes in advance with a live ETA countdown.
- Multi-factor scatter score (0–100%) – Weighted composite of cross-track distance, reflection geometry, aircraft altitude, fuselage alignment, transmitter ERP, and FM frequency — scaled by aircraft size category.
- Interactive Leaflet map – Draggable, resizable floating panel with aircraft icons, TX dots, dashed scatter path lines, compass filter, and frequency filter; all colour-coded by score.
- Topographic elevation profile – Interactive RX→TX terrain cross-section with LOS ceiling curves, scatter zone (purple), and live aircraft dot positions; zoomable and pannable.
- Persistent crossing tracker – Once a candidate is detected it stays visible through approach, peak (NOW ✓), and recession, smoothly updated by dead reckoning between 15-second ADS-B fetches.
- TX database integration – Loads all FM transmitters within 750 km radius (≥ 100 kW ERP) from maps.fmdx.org with 24-hour local cache and automatic invalidation on location drift.
- ADS-B triple-source failover – Queries adsb.one → adsb.lol → adsb.fi automatically; remembers the last working source and uses it preferentially on the next cycle.
- One-click receiver tuning – Clicking any frequency in the TX detail panel sends a tune command over the FM-DX-Webserver WebSocket, instantly retuning the receiver to the target frequency.
- GPS WebSocket integration – Receives live GPS position from the FM-DX-Webserver data feed; falls back gracefully to manually configured QTH coordinates.
- Compass & frequency filters – Eight-direction compass rose restricts candidates to a 45° bearing sector; frequency input simultaneously filters the map and tunes the receiver.

## Installation notes:

1. [Download](https://github.com/Highpoint2000/AirplaneScatter/releases) the last repository as a zip
2. Unpack all files from the plugins folder to ..fm-dx-webserver-main\plugins\ 
3. Stop or close the fm-dx-webserver
4. Start/Restart the fm-dx-webserver with "npm run webserver" on node.js console, check the console informations
5. Activate the sysinfo plugin in the settings
6. Stop or close the fm-dx-webserver
7. Start/Restart the fm-dx-webserver with "npm run webserver" on node.js console, check the console informations 
8. Reload the browser

## How to use:     
                                         
Please refer to the documentation: https://highpoint.fmdx.org/manuals/AirplaneScatter-Documentation.html

## Contact

If you have any questions, would like to report problems, or have suggestions for improvement, please feel free to contact me! You can reach me by email at highpoint2000@googlemail.com. I look forward to hearing from you!

<a href="https://www.buymeacoffee.com/Highpoint" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png" alt="Buy Me A Coffee" style="height: 60px !important;width: 217px !important;" ></a>

<details>
<summary>History</summary>



