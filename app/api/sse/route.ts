import { NextRequest } from 'next/server';
import { getDeviceManager } from '@/lib/device-manager';

export async function GET(request: NextRequest) {
  const encoder = new TextEncoder();
  let intervalId: NodeJS.Timeout;
  let isConnected = true;

  const stream = new ReadableStream({
    start(controller) {
      const deviceManager = getDeviceManager();
      
      // Send initial connection
      controller.enqueue(encoder.encode(': connected\n\n'));
      
      // Send current device list immediately
      const devices = deviceManager.getDevices();
      controller.enqueue(
        encoder.encode(`event: devices\ndata: ${JSON.stringify(devices)}\n\n`)
      );
      
      // Listen for device updates
      const handleDevicesUpdated = (updatedDevices: any[]) => {
        if (isConnected) {
          controller.enqueue(
            encoder.encode(`event: devices\ndata: ${JSON.stringify(updatedDevices)}\n\n`)
          );
        }
      };
      
      // Listen for individual device data updates
      const handleDeviceDataUpdated = (update: any) => {
        if (isConnected) {
          controller.enqueue(
            encoder.encode(`event: deviceData\ndata: ${JSON.stringify(update)}\n\n`)
          );
        }
      };
      
      // Listen for scan status updates
      const handleScanStatus = (status: any) => {
        if (isConnected) {
          controller.enqueue(
            encoder.encode(`event: scanStatus\ndata: ${JSON.stringify(status)}\n\n`)
          );
        }
      };
      
      // Register event listeners
      deviceManager.on('devicesUpdated', handleDevicesUpdated);
      deviceManager.on('deviceDataUpdated', handleDeviceDataUpdated);
      deviceManager.on('scanStatus', handleScanStatus);
      
      // Keep connection alive with heartbeat
      intervalId = setInterval(() => {
        if (isConnected) {
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        }
      }, 30000);
      
      // Cleanup on close
      request.signal.addEventListener('abort', () => {
        isConnected = false;
        clearInterval(intervalId);
        deviceManager.removeListener('devicesUpdated', handleDevicesUpdated);
        deviceManager.removeListener('deviceDataUpdated', handleDeviceDataUpdated);
        deviceManager.removeListener('scanStatus', handleScanStatus);
        controller.close();
      });
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}