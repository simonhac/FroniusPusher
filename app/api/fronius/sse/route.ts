import { NextRequest } from 'next/server';
import { getDeviceManager } from '@/lib/device-manager';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const deviceManager = getDeviceManager();
  
  // Create a TransformStream for SSE
  const stream = new TransformStream();
  const writer = stream.writable.getWriter();
  const encoder = new TextEncoder();

  // Send initial data
  const sendEvent = (eventType: string, data: any) => {
    const message = `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
    writer.write(encoder.encode(message));
  };

  // Send initial device list
  sendEvent('devices', deviceManager.getDevices());

  // Set up event listeners
  const devicesUpdatedHandler = (devices: any) => {
    sendEvent('devices', devices);
  };

  const deviceDataUpdatedHandler = (update: any) => {
    sendEvent('deviceData', update);
  };

  const scanStatusHandler = (status: any) => {
    sendEvent('scanStatus', status);
  };

  deviceManager.on('devicesUpdated', devicesUpdatedHandler);
  deviceManager.on('deviceDataUpdated', deviceDataUpdatedHandler);
  deviceManager.on('scanStatus', scanStatusHandler);

  // Clean up on disconnect
  request.signal.addEventListener('abort', () => {
    deviceManager.off('devicesUpdated', devicesUpdatedHandler);
    deviceManager.off('deviceDataUpdated', deviceDataUpdatedHandler);
    deviceManager.off('scanStatus', scanStatusHandler);
    writer.close();
  });

  // Send heartbeat every 30 seconds
  const heartbeat = setInterval(() => {
    try {
      writer.write(encoder.encode(':heartbeat\n\n'));
    } catch (error) {
      clearInterval(heartbeat);
    }
  }, 30000);

  request.signal.addEventListener('abort', () => {
    clearInterval(heartbeat);
  });

  return new Response(stream.readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}