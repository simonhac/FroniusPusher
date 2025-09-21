import { NextRequest } from 'next/server';
import { getSite } from '@/lib/site';
import { formatLocalDateTime } from '@/lib/date-utils';

export const runtime = 'nodejs';

// JSON replacer function to format dates
const dateReplacer = (key: string, value: any) => {
  if (value instanceof Date) {
    return formatLocalDateTime(value);
  }
  return value;
};

export async function GET(request: NextRequest) {
  const encoder = new TextEncoder();
  let intervalId: NodeJS.Timeout;
  let isConnected = true;

  const stream = new ReadableStream({
    async start(controller) {
      const site = getSite();
      
      // Send initial connection
      controller.enqueue(encoder.encode(': connected\n\n'));
      
      // Test LiveOne connection and send results
      const liveOneService = site.getLiveOneService();
      if (liveOneService) {
        try {
          const testResult = await liveOneService.testConnection();
          controller.enqueue(
            encoder.encode(`event: pushTest\ndata: ${JSON.stringify(testResult, dateReplacer)}\n\n`)
          );
        } catch (error: any) {
          controller.enqueue(
            encoder.encode(`event: pushTest\ndata: ${JSON.stringify({
              success: false,
              message: 'Test failed',
              error: error.message
            }, dateReplacer)}\n\n`)
          );
        }
      }
      
      // Send site info immediately (includes devices)
      const siteInfo = site.getSiteInfo();
      controller.enqueue(
        encoder.encode(`event: siteUpdate\ndata: ${JSON.stringify(siteInfo, dateReplacer)}\n\n`)
      );
      
      // Send the most recent site metrics so tiles can render immediately
      const latestSiteMetrics = site.getLatestSiteMetrics();
      if (latestSiteMetrics) {
        controller.enqueue(
          encoder.encode(`event: siteMetrics\ndata: ${JSON.stringify(latestSiteMetrics, dateReplacer)}\n\n`)
        );
      }
      
      // Send high-resolution historical data for charts
      const hiresHistory = site.getHistoricalData();
      controller.enqueue(
        encoder.encode(`event: hiresHistory\ndata: ${JSON.stringify(hiresHistory, dateReplacer)}\n\n`)
      );
      
      // Send minutely history (FroniusMinutely reports)
      const minutelyHistory = site.getFroniusMinutelyHistory();
      controller.enqueue(
        encoder.encode(`event: minutelyHistory\ndata: ${JSON.stringify(minutelyHistory, dateReplacer)}\n\n`)
      );
      
      // Listen for site updates (sent after scanning completes)
      const handleSiteUpdate = (siteInfo: any) => {
        if (isConnected) {
          controller.enqueue(
            encoder.encode(`event: siteUpdate\ndata: ${JSON.stringify(siteInfo, dateReplacer)}\n\n`)
          );
        }
      };
      
      // Listen for scan status updates
      const handleScanStatus = (status: any) => {
        if (isConnected) {
          controller.enqueue(
            encoder.encode(`event: scanStatus\ndata: ${JSON.stringify(status, dateReplacer)}\n\n`)
          );
        }
      };
      
      // Listen for FroniusMinutely updates (once per minute)
      const handleFroniusMinutely = (data: any) => {
        if (isConnected) {
          controller.enqueue(
            encoder.encode(`event: froniusMinutely\ndata: ${JSON.stringify(data, dateReplacer)}\n\n`)
          );
        }
      };
      
      // Listen for inverter heartbeat updates
      const handleInverterHeartbeat = (data: any) => {
        if (isConnected) {
          controller.enqueue(
            encoder.encode(`event: inverterHeartbeat\ndata: ${JSON.stringify(data, dateReplacer)}\n\n`)
          );
        }
      };
      
      // Listen for site metrics events
      const handleSiteMetrics = (data: any) => {
        if (isConnected) {
          controller.enqueue(
            encoder.encode(`event: siteMetrics\ndata: ${JSON.stringify(data, dateReplacer)}\n\n`)
          );
        }
      };
      
      // Register event listeners
      site.on('siteUpdate', handleSiteUpdate);
      site.on('scanStatus', handleScanStatus);
      site.on('froniusMinutely', handleFroniusMinutely);
      site.on('inverterHeartbeat', handleInverterHeartbeat);
      site.on('siteMetrics', handleSiteMetrics);
      
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
        site.removeListener('siteUpdate', handleSiteUpdate);
        site.removeListener('scanStatus', handleScanStatus);
        site.removeListener('froniusMinutely', handleFroniusMinutely);
        site.removeListener('inverterHeartbeat', handleInverterHeartbeat);
        site.removeListener('siteMetrics', handleSiteMetrics);
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