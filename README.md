# Plotline — Plot Digitizer

A browser-based workbench for calibrating engineering plots, manually tracing datasets, and exporting calibrated values.

## Run locally

Install the Node dependencies with `npm install`, then start the development server with `npm run dev`.

## Current capabilities

- Upload common raster plot images and crop, rotate, or flip them before tracing.
- Calibrate X and Y axes with two or more known tick points using linear, logarithmic, inverse, or numeric date/time coordinates.
- Create, rename, recolor, delete, and manually digitize multiple datasets; drag points to adjust, right-click near a point to remove, and use the cursor magnifier for precise placement.
- Use nearest-color X-step tracing with a configurable tolerance and sample step.
- Work in Compressor Map mode with required Surge and Choke boundary datasets, RPM-tagged speed lines, optional efficiency contours, proximity-based trace stopping, and structured JSON arrays for flow, pressure ratio, RPM, and efficiency.
- Inspect calibrated point tables, measure distances/angles, sort output by X or Y, set significant-digit precision, and export CSV/JSON (or save/reopen an editable JSON project with embedded image data).

Project files are saved by the user as local JSON downloads; image data is not sent to a server. The Python calibration module in `plot_digitizer/` remains available for backend/service integration.

## Current limitations

AI/OCR calibration suggestions in the UI, perspective deskew, morphology-based grid removal, Blob/Averaging Window extractors, Polar/Ternary/Map coordinate transforms, spline smoothing, and trajectory-aware junction tracking are not implemented yet. The Python calibration module includes optional OCR proposals, but it is not currently wired into the browser app. Compressor boundary stopping uses proximity to sampled boundary points; it is not geometric intersection solving. These features should be treated as follow-up engineering work, not completed parity claims.
