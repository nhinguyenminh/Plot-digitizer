# Plotline — Plot Digitizer

A browser-based workbench for calibrating engineering plots, manually tracing datasets, and exporting calibrated values.

## Run locally

Install the Node dependencies with `npm install`, then start the development server with `npm run dev`.

## Current capabilities

- Upload common raster plot images and crop, rotate, or flip them before tracing; prepare scans with brightness, contrast, sharpening, grayscale, color inversion, and manual or automatic thresholding.
- Calibrate X and Y axes with two or more known tick points using linear, logarithmic, inverse, or numeric date/time coordinates. A guided four-point workflow collects two references for each axis.
- Create, rename, recolor, delete, and digitize multiple datasets; drag or keyboard-nudge points, edit pixel coordinates in the data table, right-click near a point to remove, and use the cursor magnifier for precise placement.
- Use bidirectional color tracing with configurable tolerance and sample step; continuation scoring follows local curve direction to reduce jumps to nearby branches.
- Work in Compressor Map mode with configurable axis quantities/labels/units (flow, head, outlet pressure, pressure ratio, efficiency, speed, IGV, or custom), speed and IGV tags on speed lines, efficiency-contour values, optional Surge/Choke boundaries, and structured JSON output.
- Inspect calibrated point tables, measure distances/angles, sort output by X or Y, set significant-digit precision, and export CSV/JSON (or save/reopen an editable JSON project with embedded image data).

Project files are saved by the user as local JSON downloads; image data is not sent to a server. The Python calibration module in `plot_digitizer/` remains available for backend/service integration.

## Current limitations

OCR calibration suggestions, perspective deskew, morphology-based grid removal, Blob/Averaging Window extractors, Polar/Ternary/Map coordinate transforms, spline smoothing, and trajectory-aware junction tracking are not implemented yet. The automatic image threshold is global Otsu thresholding, not local/adaptive thresholding. The four-point calibration workflow guides the user through selecting and labeling four locations; it does not automatically recognize tick labels. The Python calibration module includes optional OCR proposals, but it is not currently wired into the browser app. Compressor boundary stopping uses proximity to sampled boundary points; it is not geometric intersection solving. These features should be treated as follow-up engineering work, not completed parity claims.
