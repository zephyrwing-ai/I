import { getStroke } from "perfect-freehand";
import type { AnimationFrameHandler } from "./animation-frame-handler";
import type { AppState } from "./types";
import { getSvgPathFromStroke, sceneCoordsToViewportCoords } from "./utils";
import type App from "./components/App";
import { SVG_NS } from "./constants";

export interface Trail {
  start(container: SVGSVGElement): void;
  stop(): void;

  startPath(x: number, y: number): void;
  addPointToPath(x: number, y: number): void;
  endPath(): void;
}

export interface AnimatedTrailOptions {
  fill: (trail: AnimatedTrail) => string;
}

type TrailPoint = [x: number, y: number, pressure: number];

type TrailPointerOptions = {
  size?: number;
  streamline?: number;
  keepHead?: boolean;
};

class TrailPointer {
  public readonly options: Required<TrailPointerOptions>;
  public readonly originalPoints: TrailPoint[] = [];
  private closedAt: number | null = null;

  constructor(options: TrailPointerOptions) {
    this.options = {
      size: 2,
      streamline: 0.45,
      keepHead: false,
      ...options,
    };
  }

  addPoint(point: TrailPoint): void {
    const previous = this.originalPoints.at(-1);
    if (previous && previous[0] === point[0] && previous[1] === point[1]) {
      return;
    }
    this.originalPoints.push(point);
  }

  close(): void {
    this.closedAt = performance.now();
  }

  getStrokeOutline(sizeOverride?: number): [number, number][] {
    if (
      this.closedAt !== null &&
      !this.options.keepHead &&
      performance.now() - this.closedAt > 250
    ) {
      return [];
    }

    const points = this.originalPoints.map(([x, y]) => [x, y] as [number, number]);
    return getStroke(points.length === 1 ? [...points, points[0]] : points, {
      size: sizeOverride ?? this.options.size,
      streamline: this.options.streamline,
      last: !this.options.keepHead,
    }).map(([x, y]): [number, number] => [x, y]);
  }
}

export class AnimatedTrail implements Trail {
  private currentTrail?: TrailPointer;
  private pastTrails: TrailPointer[] = [];

  private container?: SVGSVGElement;
  private trailElement: SVGPathElement;

  constructor(
    private animationFrameHandler: AnimationFrameHandler,
    private app: App,
    private options: TrailPointerOptions &
      Partial<AnimatedTrailOptions>,
  ) {
    this.animationFrameHandler.register(this, this.onFrame.bind(this));

    this.trailElement = document.createElementNS(SVG_NS, "path");
  }

  get hasCurrentTrail() {
    return !!this.currentTrail;
  }

  hasLastPoint(x: number, y: number) {
    if (this.currentTrail) {
      const len = this.currentTrail.originalPoints.length;
      return (
        this.currentTrail.originalPoints[len - 1][0] === x &&
        this.currentTrail.originalPoints[len - 1][1] === y
      );
    }

    return false;
  }

  start(container?: SVGSVGElement) {
    if (container) {
      this.container = container;
    }

    if (this.trailElement.parentNode !== this.container && this.container) {
      this.container.appendChild(this.trailElement);
    }

    this.animationFrameHandler.start(this);
  }

  stop() {
    this.animationFrameHandler.stop(this);

    if (this.trailElement.parentNode === this.container) {
      this.container?.removeChild(this.trailElement);
    }
  }

  startPath(x: number, y: number) {
    this.currentTrail = new TrailPointer(this.options);

    this.currentTrail.addPoint([x, y, performance.now()]);

    this.update();
  }

  addPointToPath(x: number, y: number) {
    if (this.currentTrail) {
      this.currentTrail.addPoint([x, y, performance.now()]);
      this.update();
    }
  }

  endPath() {
    if (this.currentTrail) {
      this.currentTrail.close();
      this.currentTrail.options.keepHead = false;
      this.pastTrails.push(this.currentTrail);
      this.currentTrail = undefined;
      this.update();
    }
  }

  private update() {
    this.start();
  }

  private onFrame() {
    const paths: string[] = [];

    for (const trail of this.pastTrails) {
      paths.push(this.drawTrail(trail, this.app.state));
    }

    if (this.currentTrail) {
      const currentPath = this.drawTrail(this.currentTrail, this.app.state);

      paths.push(currentPath);
    }

    this.pastTrails = this.pastTrails.filter((trail) => {
      return trail.getStrokeOutline().length !== 0;
    });

    if (paths.length === 0) {
      this.stop();
    }

    const svgPaths = paths.join(" ").trim();

    this.trailElement.setAttribute("d", svgPaths);
    this.trailElement.setAttribute(
      "fill",
      (this.options.fill ?? (() => "black"))(this),
    );
  }

  private drawTrail(trail: TrailPointer, state: AppState): string {
    const stroke = trail
      .getStrokeOutline(trail.options.size / state.zoom.value)
      .map(([x, y]) => {
        const result = sceneCoordsToViewportCoords(
          { sceneX: x, sceneY: y },
          state,
        );

        return [result.x, result.y];
      });

    return getSvgPathFromStroke(stroke, true);
  }
}
