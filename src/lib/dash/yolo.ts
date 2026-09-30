import { YOLO, type YOLO as YoloModel } from "@ultralytics/yolo";

export type Detector = YoloModel;

let pending: Promise<YoloModel> | null = null;

export function loadDetector(): Promise<YoloModel> {
  if (!pending) {
    pending = YOLO.load("/models/yolo26n.onnx", { device: "auto" }).catch((err: unknown) => {
      pending = null;
      throw err;
    });
  }
  return pending;
}
