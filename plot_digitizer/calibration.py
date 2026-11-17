from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from typing import Iterable, Sequence

import numpy as np


class Scale(str, Enum):
    LINEAR = "linear"
    LOG10 = "log10"
    INVERSE = "inverse"
    DATETIME = "datetime"


@dataclass(frozen=True)
class CalibrationPoint:
    pixel: float
    value: float | datetime | str


@dataclass(frozen=True)
class AxisCalibration:
    """A one-dimensional pixel-to-data calibration, independent for X and Y."""

    points: tuple[CalibrationPoint, ...]
    scale: Scale = Scale.LINEAR
    date_format: str | None = None

    def __post_init__(self) -> None:
        if len(self.points) < 2:
            raise ValueError("At least two calibration points are required")
        pixels = np.asarray([p.pixel for p in self.points], dtype=float)
        if not np.isfinite(pixels).all() or len(np.unique(pixels)) != len(pixels):
            raise ValueError("Pixel coordinates must be finite and unique")
        values = np.asarray([self._to_numeric(p.value) for p in self.points], dtype=float)
        if not np.isfinite(values).all():
            raise ValueError("Calibration values must be finite")
        if self.scale is Scale.LOG10 and np.any(values <= 0):
            raise ValueError("Logarithmic calibration values must be positive")
        transformed = self._forward(values)
        if len(np.unique(transformed)) < 2:
            raise ValueError("Calibration values must span at least two distinct values")

    def _to_numeric(self, value: float | datetime | str) -> float:
        if self.scale is Scale.DATETIME:
            if isinstance(value, datetime):
                return value.timestamp()
            if isinstance(value, str):
                if self.date_format:
                    return datetime.strptime(value, self.date_format).timestamp()
                return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp()
            return float(value)
        return float(value)

    def _forward(self, values: np.ndarray) -> np.ndarray:
        if self.scale is Scale.LOG10:
            return np.log10(values)
        if self.scale is Scale.INVERSE:
            if np.any(values == 0):
                raise ValueError("Inverse calibration values cannot be zero")
            return 1.0 / values
        return values

    def _inverse(self, values: np.ndarray) -> np.ndarray:
        if self.scale is Scale.LOG10:
            return np.power(10.0, values)
        if self.scale is Scale.INVERSE:
            if np.any(values == 0):
                raise ValueError("Inverse mapping reaches zero in transformed space")
            return 1.0 / values
        return values

    def pixel_to_data(self, pixel: float | Sequence[float]) -> float | np.ndarray:
        """Map pixels with a least-squares line for 2 points, piecewise linear for 3+."""
        pixels = np.asarray([p.pixel for p in self.points], dtype=float)
        values = np.asarray([self._to_numeric(p.value) for p in self.points], dtype=float)
        transformed = self._forward(values)
        query = np.asarray(pixel, dtype=float)
        if len(pixels) == 2:
            slope, intercept = np.polyfit(pixels, transformed, 1)
            mapped = self._inverse(slope * query + intercept)
        else:
            order = np.argsort(pixels)
            mapped = self._inverse(np.interp(query, pixels[order], transformed[order]))
        return float(mapped) if mapped.ndim == 0 else mapped

    def data_to_pixel(self, value: float | datetime | str | Sequence[float]) -> float | np.ndarray:
        pixels = np.asarray([p.pixel for p in self.points], dtype=float)
        values = np.asarray([self._to_numeric(p.value) for p in self.points], dtype=float)
        query = np.asarray([self._to_numeric(v) for v in value], dtype=float) if isinstance(value, (list, tuple, np.ndarray)) else np.asarray(self._to_numeric(value))
        transformed = self._forward(values)
        query_transformed = self._forward(query)
        if len(pixels) == 2:
            slope, intercept = np.polyfit(transformed, pixels, 1)
            mapped = slope * query_transformed + intercept
        else:
            order = np.argsort(transformed)
            mapped = np.interp(query_transformed, transformed[order], pixels[order])
        return float(mapped) if np.ndim(mapped) == 0 else mapped

    def formatted_value(self, pixel: float, precision: int = 4) -> str:
        value = float(self.pixel_to_data(pixel))
        if self.scale is Scale.DATETIME:
            return datetime.fromtimestamp(value).isoformat(sep=" ", timespec="seconds")
        return f"{value:.{precision}g}"


@dataclass(frozen=True)
class CalibrationProposal:
    """Machine-detected suggestions. Proposals must be reviewed before use."""

    axis: str
    pixel: float
    text: str
    confidence: float
    confirmed: bool = False


class CalibrationManager:
    """Owns axis calibrations and optional, human-confirmed OCR suggestions."""

    def __init__(self) -> None:
        self._axes: dict[str, AxisCalibration] = {}
        self._pending: dict[str, list[CalibrationPoint]] = {"x": [], "y": []}

    def calibrate_axis(
        self,
        axis: str,
        points: Iterable[CalibrationPoint],
        scale: Scale | str = Scale.LINEAR,
        date_format: str | None = None,
    ) -> AxisCalibration:
        axis = axis.lower()
        if axis not in {"x", "y"}:
            raise ValueError("axis must be 'x' or 'y'")
        calibration = AxisCalibration(tuple(points), Scale(scale), date_format)
        self._axes[axis] = calibration
        return calibration

    def add_point(self, axis: str, point: CalibrationPoint, scale: Scale | str = Scale.LINEAR) -> AxisCalibration | None:
        axis = axis.lower()
        if axis not in {"x", "y"}:
            raise ValueError("axis must be 'x' or 'y'")
        existing = self._axes.get(axis)
        points = list(existing.points if existing else self._pending[axis])
        points.append(point)
        if len(points) < 2:
            self._pending[axis] = points
            return None
        chosen_scale = existing.scale if existing else Scale(scale)
        chosen_format = existing.date_format if existing else None
        calibration = AxisCalibration(tuple(points), chosen_scale, chosen_format)
        self._axes[axis] = calibration
        self._pending[axis] = []
        return calibration

    def pixel_to_data(self, x_pixel: float, y_pixel: float) -> tuple[float, float]:
        if "x" not in self._axes or "y" not in self._axes:
            raise RuntimeError("Both X and Y axes must be calibrated")
        return float(self._axes["x"].pixel_to_data(x_pixel)), float(self._axes["y"].pixel_to_data(y_pixel))

    def data_to_pixel(self, x_value: float, y_value: float) -> tuple[float, float]:
        if "x" not in self._axes or "y" not in self._axes:
            raise RuntimeError("Both X and Y axes must be calibrated")
        return float(self._axes["x"].data_to_pixel(x_value)), float(self._axes["y"].data_to_pixel(y_value))

    @property
    def axes(self) -> dict[str, AxisCalibration]:
        return self._axes.copy()

    def propose_from_image(self, image: np.ndarray, ocr_engine: str = "tesseract") -> list[CalibrationProposal]:
        """Detect plot axes with Hough lines and suggest nearby numeric tick labels.

        Requires OpenCV and either pytesseract (default) or easyocr. Suggestions
        are intentionally unconfirmed: the caller should let a user review labels
        and pixel positions before passing points to calibrate_axis().
        """
        try:
            import cv2
        except ImportError as exc:
            raise RuntimeError("Install opencv-python to use image-assisted calibration") from exc
        if image is None or image.ndim not in (2, 3):
            raise ValueError("image must be a grayscale or color image array")
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY) if image.ndim == 3 else image
        edges = cv2.Canny(gray, 50, 150)
        lines = cv2.HoughLinesP(edges, 1, np.pi / 180, threshold=80,
                                minLineLength=max(30, min(gray.shape) // 5), maxLineGap=12)
        if lines is None:
            return []
        horizontal: list[tuple[int, int, int, int]] = []
        vertical: list[tuple[int, int, int, int]] = []
        for raw in lines[:, 0, :]:
            x1, y1, x2, y2 = map(int, raw)
            angle = abs(np.degrees(np.arctan2(y2 - y1, x2 - x1)))
            if angle < 8 or angle > 172:
                horizontal.append((x1, y1, x2, y2))
            elif 82 < angle < 98:
                vertical.append((x1, y1, x2, y2))
        if not horizontal or not vertical:
            return []
        # Plot frame is approximated from the longest detected horizontal/vertical lines.
        x_axis = max(horizontal, key=lambda line: abs(line[2] - line[0]))
        y_axis = max(vertical, key=lambda line: abs(line[3] - line[1]))
        x_axis_y = float((x_axis[1] + x_axis[3]) / 2)
        y_axis_x = float((y_axis[0] + y_axis[2]) / 2)
        if ocr_engine == "tesseract":
            try:
                import pytesseract
                from pytesseract import Output
            except ImportError as exc:
                raise RuntimeError("Install pytesseract and the Tesseract executable for OCR") from exc
            data = pytesseract.image_to_data(gray, config="--psm 11", output_type=Output.DICT)
            items = [(data["text"][i].strip(), float(data["conf"][i]),
                      float(data["left"][i] + data["width"][i] / 2),
                      float(data["top"][i] + data["height"][i] / 2)) for i in range(len(data["text"]))]
        elif ocr_engine == "easyocr":
            try:
                import easyocr
            except ImportError as exc:
                raise RuntimeError("Install easyocr to use the EasyOCR engine") from exc
            results = easyocr.Reader(["en"], gpu=False).readtext(gray)
            items = [(text, float(confidence), float(np.mean([p[0] for p in box])),
                      float(np.mean([p[1] for p in box]))) for box, text, confidence in results]
        else:
            raise ValueError("ocr_engine must be 'tesseract' or 'easyocr'")
        proposals: list[CalibrationProposal] = []
        for text, confidence, cx, cy in items:
            normalized = text.replace(",", "").strip()
            if not normalized or confidence < 20:
                continue
            # Associate labels below the horizontal axis with X and left of the
            # vertical axis with Y; users confirm/correct orientation in the UI.
            axis = "x" if cy >= x_axis_y else "y" if cx <= y_axis_x else None
            if axis is None:
                continue
            try:
                if axis == "x":
                    float(normalized)
                    pixel = cx
                else:
                    float(normalized)
                    pixel = cy
            except ValueError:
                continue
            proposals.append(CalibrationProposal(axis, pixel, normalized, min(confidence / 100, 1.0)))
        return sorted(proposals, key=lambda proposal: (proposal.axis, proposal.pixel))
