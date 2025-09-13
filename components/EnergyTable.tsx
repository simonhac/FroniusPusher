'use client';

import React from 'react';

interface EnergyCounters {
  solar?: number;
  batteryIn?: number;
  batteryOut?: number;
  gridIn?: number;
  gridOut?: number;
  load?: number;
}

interface DeviceEnergyData {
  ip: string;
  name: string;
  energyCounters: EnergyCounters;
}

interface EnergyTableProps {
  devices: DeviceEnergyData[];
}

export default function EnergyTable({ devices }: EnergyTableProps) {
  if (!devices || devices.length === 0) {
    return null;
  }

  const formatEnergy = (value: number | undefined) => {
    if (value === undefined || value === null) return '-';
    return value.toFixed(3);
  };

  // Aggregate all energy types across devices
  const energyTypes = [
    { 
      key: 'solar', 
      label: 'Solar Generated', 
      color: 'text-yellow-400',
      icon: (
        <svg className="w-4 h-4 text-yellow-400" fill="currentColor" viewBox="0 0 20 20">
          <path fillRule="evenodd" d="M10 2a1 1 0 011 1v1a1 1 0 11-2 0V3a1 1 0 011-1zm4 8a4 4 0 11-8 0 4 4 0 018 0zm-.464 4.95l.707.707a1 1 0 001.414-1.414l-.707-.707a1 1 0 00-1.414 1.414zm2.12-10.607a1 1 0 010 1.414l-.706.707a1 1 0 11-1.414-1.414l.707-.707a1 1 0 011.414 0zM17 11a1 1 0 100-2h-1a1 1 0 100 2h1zm-7 4a1 1 0 011 1v1a1 1 0 11-2 0v-1a1 1 0 011-1zM5.05 6.464A1 1 0 106.465 5.05l-.708-.707a1 1 0 00-1.414 1.414l.707.707zm1.414 8.486l-.707.707a1 1 0 01-1.414-1.414l.707-.707a1 1 0 011.414 1.414zM4 11a1 1 0 100-2H3a1 1 0 000 2h1z" clipRule="evenodd" />
        </svg>
      )
    },
    { 
      key: 'batteryIn', 
      label: <span>Battery Charged<sup className="text-xs">*</sup></span>, 
      color: 'text-green-400',
      icon: (
        <svg className="w-4 h-4 text-green-400" fill="currentColor" viewBox="0 0 24 24">
          <path d="M4 6a2 2 0 00-2 2v8a2 2 0 002 2h12a2 2 0 002-2v-2h2a1 1 0 001-1v-2a1 1 0 00-1-1h-2V8a2 2 0 00-2-2H4zm0 2h12v8H4V8z"/>
          <path d="M6 10h8v4H6z" opacity="0.5"/>
        </svg>
      )
    },
    { 
      key: 'batteryOut', 
      label: <span>Battery Discharged<sup className="text-xs">*</sup></span>, 
      color: 'text-blue-400',
      icon: (
        <svg className="w-4 h-4 text-blue-400" fill="currentColor" viewBox="0 0 24 24">
          <path d="M4 6a2 2 0 00-2 2v8a2 2 0 002 2h12a2 2 0 002-2v-2h2a1 1 0 001-1v-2a1 1 0 00-1-1h-2V8a2 2 0 00-2-2H4zm0 2h12v8H4V8z"/>
        </svg>
      )
    },
    { 
      key: 'gridIn', 
      label: 'Grid Import', 
      color: 'text-purple-400',
      icon: (
        <svg className="w-4 h-4 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 8l4 4m0 0l-4 4m4-4H3" />
        </svg>
      )
    },
    { 
      key: 'gridOut', 
      label: 'Grid Export', 
      color: 'text-purple-400',
      icon: (
        <svg className="w-4 h-4 text-purple-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16l-4-4m0 0l4-4m-4 4h18" />
        </svg>
      )
    },
    { 
      key: 'load', 
      label: <span>Load Consumed<sup className="text-xs">†</sup></span>, 
      color: 'text-orange-400',
      icon: (
        <svg className="w-4 h-4 text-orange-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
        </svg>
      )
    }
  ];

  // Filter to only show rows where at least one device has data
  const visibleEnergyTypes = energyTypes.filter(type => 
    devices.some(device => {
      const value = device.energyCounters?.[type.key as keyof EnergyCounters];
      return value !== undefined && value !== null;
    })
  );

  if (visibleEnergyTypes.length === 0) {
    return null;
  }

  // Calculate totals for each energy type
  const calculateTotal = (key: keyof EnergyCounters) => {
    return devices.reduce((sum, device) => {
      const value = device.energyCounters?.[key];
      return sum + (value !== undefined && value !== null ? value : 0);
    }, 0);
  };

  return (
    <div className="bg-gray-900 rounded-lg p-4 mt-4">
      <h3 className="text-lg font-semibold text-white mb-3">Energy Counters (kWh)</h3>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-700">
              <th className="text-left py-2 px-3 text-gray-400 font-medium">Type</th>
              {devices.map(device => (
                <th key={device.ip} className="text-right py-2 px-3 text-gray-400 font-medium min-w-[100px]">
                  {device.name}
                </th>
              ))}
              {devices.length > 1 && (
                <th className="text-right py-2 px-3 text-gray-400 font-medium min-w-[100px] border-l border-gray-700">
                  Total
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {visibleEnergyTypes.map((type, index) => (
              <tr key={type.key} className={index < visibleEnergyTypes.length - 1 ? "border-b border-gray-800" : ""}>
                <td className="py-2 px-3">
                  <div className="flex items-center space-x-2">
                    {type.icon}
                    <span className="text-gray-300">{type.label}</span>
                  </div>
                </td>
                {devices.map(device => {
                  const value = device.energyCounters?.[type.key as keyof EnergyCounters];
                  return (
                    <td key={device.ip} className={`text-right py-2 px-3 ${type.color} font-mono font-medium`}>
                      {formatEnergy(value)}
                    </td>
                  );
                })}
                {devices.length > 1 && (
                  <td className={`text-right py-2 px-3 ${type.color} font-mono font-bold border-l border-gray-700`}>
                    {formatEnergy(calculateTotal(type.key as keyof EnergyCounters))}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-3 pt-3 border-t border-gray-700">
        <p className="text-xs text-gray-500">
          Energy values are net changes since system startup.
          <span className="ml-2">* Accumulated from power readings</span>
          <span className="ml-2">† Calculated using energy balance</span>
        </p>
      </div>
    </div>
  );
}