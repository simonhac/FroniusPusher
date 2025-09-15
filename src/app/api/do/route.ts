import { NextRequest, NextResponse } from 'next/server';
import { getSite } from '@/lib/site';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const action = body.action;
    
    if (action === 'scan') {
      const site = getSite();
      // Don't await - let it run in background
      site.scanForDevices();
      
      return NextResponse.json({
        success: true,
        message: 'Scan initiated'
      });
    }
    
    return NextResponse.json(
      { success: false, error: 'Invalid action' },
      { status: 400 }
    );
  } catch (error) {
    console.error('Error processing action:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}