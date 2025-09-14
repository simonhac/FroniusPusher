'use client';

import React from 'react';
import { Sun, Battery, Zap, Home, ArrowRight, ArrowLeft } from 'lucide-react';

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
  siteEnergy: EnergyCounters | null;
}

export default function EnergyTable({ devices, siteEnergy }: EnergyTableProps) {
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
      icon: <Sun className="w-4 h-4 text-yellow-400" />
    },
    { 
      key: 'batteryIn', 
      label: 'Battery Charged', 
      color: 'text-green-400',
      icon: <Battery className="w-4 h-4 text-green-400" />
    },
    { 
      key: 'batteryOut', 
      label: 'Battery Discharged', 
      color: 'text-blue-400',
      icon: <Battery className="w-4 h-4 text-blue-400" />
    },
    { 
      key: 'gridIn', 
      label: 'Grid Import', 
      color: 'text-purple-400',
      icon: <ArrowRight className="w-4 h-4 text-purple-400" />
    },
    { 
      key: 'gridOut', 
      label: 'Grid Export', 
      color: 'text-purple-400',
      icon: <ArrowLeft className="w-4 h-4 text-purple-400" />
    },
    { 
      key: 'load', 
      label: 'Load Consumed', 
      color: 'text-orange-400',
      icon: <Home className="w-4 h-4 text-orange-400" />
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

  // Get site total for each energy type
  const getSiteTotal = (key: keyof EnergyCounters) => {
    if (!siteEnergy) {
      // Fallback to summing device values if site energy not available
      return devices.reduce((sum, device) => {
        const value = device.energyCounters?.[key];
        return sum + (value !== undefined && value !== null ? value : 0);
      }, 0);
    }
    return siteEnergy[key] || 0;
  };

  return (
    <div className="bg-black rounded-lg p-4 mt-4">
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
                  // For load, show dash for individual inverters (load is site-level only)
                  const displayValue = type.key === 'load' ? undefined : value;
                  return (
                    <td key={device.ip} className={`text-right py-2 px-3 ${type.color} font-mono font-medium`}>
                      {formatEnergy(displayValue)}
                    </td>
                  );
                })}
                {devices.length > 1 && (
                  <td className={`text-right py-2 px-3 ${type.color} font-mono font-bold border-l border-gray-700`}>
                    {formatEnergy(getSiteTotal(type.key as keyof EnergyCounters))}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}