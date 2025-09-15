'use client';

import { useEffect, useState, useRef } from 'react';
import { formatDistanceToNow } from 'date-fns';

export type HealthColor = 'GREEN' | 'AMBER' | 'RED' | 'GREY';

interface HealthIndicatorProps {
  serialNumber?: string;  // For device-specific indicators
  devices?: Array<{ serialNumber: string }>;  // For site-level indicator
}

export default function HealthIndicator({ serialNumber, devices }: HealthIndicatorProps) {
  const [health, setHealth] = useState<Record<string, 'online' | 'offline'>>({});
  const [lastUpdate, setLastUpdate] = useState<Record<string, Date>>({});
  const [isPulsing, setIsPulsing] = useState(false);
  const [currentTime, setCurrentTime] = useState(new Date());
  const pulseTimeoutRef = useRef<NodeJS.Timeout | undefined>(undefined);
  
  // Update current time every second for tooltip
  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentTime(new Date());
    }, 1000);
    return () => clearInterval(interval);
  }, []);
  
  useEffect(() => {
    // Listen for heartbeat events from SSE
    const handleHeartbeat = (event: Event) => {
      const customEvent = event as CustomEvent;
      const { serialNumber: sn, status } = customEvent.detail;
      
      // Update last update time
      setLastUpdate(prev => ({
        ...prev,
        [sn]: new Date()
      }));
      
      // Trigger pulse animation when going online
      if (status === 'online') {
        if (serialNumber === sn || (!serialNumber && devices)) {
          setIsPulsing(true);
          if (pulseTimeoutRef.current) {
            clearTimeout(pulseTimeoutRef.current);
          }
          pulseTimeoutRef.current = setTimeout(() => {
            setIsPulsing(false);
          }, 150); // Hold bright for 150ms
        }
      }
      
      setHealth(prev => ({
        ...prev,
        [sn]: status
      }));
    };
    
    window.addEventListener('inverterHeartbeat', handleHeartbeat);
    
    return () => {
      window.removeEventListener('inverterHeartbeat', handleHeartbeat);
      if (pulseTimeoutRef.current) {
        clearTimeout(pulseTimeoutRef.current);
      }
    };
  }, [serialNumber, devices]);
  
  let color: HealthColor = 'GREY';
  let hasData = false;
  
  if (serialNumber) {
    // Device-specific indicator
    hasData = serialNumber in health;
    if (hasData) {
      color = health[serialNumber] === 'online' ? 'GREEN' : 'RED';
    }
  } else if (devices) {
    // Site-level indicator
    const devicesWithData = devices.filter(d => d.serialNumber in health);
    hasData = devicesWithData.length > 0;
    
    if (hasData) {
      const onlineCount = devicesWithData.filter(d => health[d.serialNumber] === 'online').length;
      if (onlineCount === devices.length && devices.length > 0) {
        color = 'GREEN';
      } else if (onlineCount > 0) {
        color = 'AMBER';
      } else {
        color = 'RED';
      }
    }
  }
  
  // Get tooltip text
  const getTooltipText = () => {
    const formatTime = (date: Date) => {
      const hours = date.getHours();
      const minutes = date.getMinutes();
      const seconds = date.getSeconds();
      const ampm = hours >= 12 ? 'pm' : 'am';
      const displayHours = hours % 12 || 12;
      const displayMinutes = minutes.toString().padStart(2, '0');
      const displaySeconds = seconds.toString().padStart(2, '0');
      return `${displayHours}:${displayMinutes}:${displaySeconds}${ampm}`;
    };
    
    if (serialNumber && lastUpdate[serialNumber]) {
      return `Last updated at ${formatTime(lastUpdate[serialNumber])}`;
    } else if (devices && devices.length > 0) {
      const updates = devices
        .filter(d => lastUpdate[d.serialNumber])
        .map(d => lastUpdate[d.serialNumber]);
      if (updates.length > 0) {
        const mostRecent = new Date(Math.max(...updates.map(d => d.getTime())));
        return `Last updated at ${formatTime(mostRecent)}`;
      }
    }
    return 'Waiting for first update...';
  };
  
  // Base classes for each color
  const baseClasses = 'w-2 h-2 rounded-full';
  
  // Determine classes based on color and animation state
  let className = baseClasses;
  
  if (color === 'GREY') {
    // Grey - waiting for first heartbeat
    className += ' bg-gray-500';
  } else if (color === 'GREEN') {
    // Green with pulse effect on update
    if (isPulsing) {
      className += ' bg-green-500 brightness-90'; // 90% brightness during pulse
    } else {
      className += ' bg-green-500 brightness-[0.6] transition-all duration-1000';
    }
  } else if (color === 'AMBER') {
    className += ' bg-amber-500';
  } else if (color === 'RED') {
    // Red with blinking animation
    className += ' bg-red-500 animate-pulse';
  }
  
  return (
    <div className="relative group">
      <div className={className} 
           style={color === 'RED' ? {
             animation: 'blink 2s infinite'
           } : undefined}>
        <style jsx>{`
          @keyframes blink {
            0%, 50% { opacity: 1; }
            51%, 100% { opacity: 0; }
          }
        `}</style>
      </div>
      {/* Tooltip */}
      <div className="absolute invisible group-hover:visible opacity-0 group-hover:opacity-100 transition-all duration-200 bg-gray-800 text-white text-xs px-2 py-1 rounded shadow-lg z-50 left-1/2 -translate-x-1/2 -top-8 whitespace-nowrap">
        {getTooltipText()}
      </div>
    </div>
  );
}