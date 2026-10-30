import { defineService } from '@nomi-ai/bundle-ig-base';

export interface DisplayInfo {
  id: string;
  name: string;
  primary: boolean;
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
}

export interface CaptureArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CaptureResult {
  displayId: string;
  mime: 'image/png' | 'image/jpeg';
  data: Uint8Array;
  width: number;
  height: number;
  capturedAt: number;
}

export interface CaptureOptions {
  displayId?: string;
  area?: CaptureArea;
  mime?: 'image/png' | 'image/jpeg';
  maxWidth?: number;
  maxHeight?: number;
}

export interface ScreenService {
  listDisplays(): Promise<DisplayInfo[]>;
  capture(opts?: CaptureOptions): Promise<CaptureResult>;
}

export const ScreenKey = defineService<ScreenService>('ctx.screen');
