# Plotline — Plot Digitizer

A browser-based workbench for calibrating engineering plots, manually tracing datasets, and exporting calibrated values.

## Run locally

Install the Node dependencies with `npm install`, then start the development server with `npm run dev`.

## Current capabilities

- Upload common raster plot images and crop, rotate, or flip them before tracing; prepare scans with brightness, contrast, sharpening, grayscale, color inversion, manual or automatic thresholding, and optional grid-line recoloring.
- Calibrate X and Y axes with two or more known tick points using linear, logarithmic, inverse, or numeric date/time coordinates. A guided four-point workflow collects two references for each axis. Grid detection can predict pixel locations from horizontal/vertical grid-line intersections; the user supplies the corresponding outer tick values and can fine-tune the resulting markers and values.
- Create, rename, recolor, delete, and digitize multiple datasets; use Modify curve points to select/drag/nudge traced points, edit pixel coordinates in the data table, right-click near a point to remove, and use the cursor magnifier for precise placement.
- Use bidirectional color tracing with configurable tolerance and sample step; continuation scoring follows local curve direction to reduce jumps to nearby branches.
- Work in Compressor Map mode with configurable axis quantities/labels/units (flow, head, outlet pressure, pressure ratio, efficiency, speed, IGV, or custom), speed and IGV tags on speed lines, efficiency-contour values, optional Surge/Choke boundaries, and structured JSON output.
- Inspect calibrated point tables, measure distances/angles, sort output by X or Y, set significant-digit precision, and export CSV/JSON (or save/reopen an editable JSON project with embedded image data).

Project files are saved by the user as local JSON downloads; image data is not sent to a server. The Python calibration module in `plot_digitizer/` remains available for backend/service integration.

## Current limitations

OCR calibration suggestions, perspective deskew, morphology-based grid removal, Blob/Averaging Window extractors, Polar/Ternary/Map coordinate transforms, spline smoothing, and trajectory-aware junction tracking are not implemented yet. Grid recoloring detects long dark lines and recolors their pixels while retaining likely curve crossings; it is a visual aid, not full grid inpainting, so inspect intersections and traces. The automatic image threshold is global Otsu thresholding, not local/adaptive thresholding. Grid-based calibration proposes outer tick locations but requires user-supplied values and confirmation; it does not recognize tick labels. The Python calibration module includes optional OCR proposals, but it is not currently wired into the browser app. Compressor boundary stopping uses proximity to sampled boundary points; it is not geometric intersection solving. These features should be treated as follow-up engineering work, not completed parity claims.
