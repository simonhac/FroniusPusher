import React from 'react';
import { Sun, Battery, Zap, Home, Info, LucideIcon } from 'lucide-react';

interface InfoItem {
  label: string;
  value: string | number;
}

interface PowerCardProps {
  label: string;
  iconName: 'solar' | 'battery' | 'grid' | 'load';
  color: 'yellow' | 'blue' | 'purple' | 'orange';
  value: number | null;
  unit?: string;
  secondaryValue?: number | null;
  secondaryUnit?: string;
  subtext?: string;
  infoItems?: InfoItem[];
  infoTitle?: string;
}

const iconMap: Record<string, LucideIcon> = {
  solar: Sun,
  battery: Battery,
  grid: Zap,
  load: Home,
};

const colorClasses = {
  yellow: {
    text: 'text-yellow-400',
    icon: 'text-yellow-400',
  },
  blue: {
    text: 'text-blue-400',
    icon: 'text-blue-400',
  },
  purple: {
    text: 'text-purple-400',
    icon: 'text-purple-400',
  },
  orange: {
    text: 'text-orange-400',
    icon: 'text-orange-400',
  },
};

export default function PowerCard({
  label,
  iconName,
  color,
  value,
  unit = 'kW',
  secondaryValue,
  secondaryUnit,
  subtext,
  infoItems,
  infoTitle,
}: PowerCardProps) {
  const Icon = iconMap[iconName];
  const colors = colorClasses[color];

  return (
    <div className="bg-gray-900 p-2 rounded w-[200px] relative">
      {/* Info Icon with Tooltip */}
      {infoItems && infoItems.length > 0 && (
        <div className="absolute top-1 right-1 group">
          <Info className="w-3.5 h-3.5 text-gray-500 hover:text-gray-300 cursor-help" />
          <div className="absolute invisible group-hover:visible opacity-0 group-hover:opacity-100 transition-all duration-300 bg-gray-800 text-white p-3 rounded-lg shadow-xl z-50 right-0 top-5">
            <div className="text-xs space-y-1 whitespace-nowrap">
              {infoTitle && (
                <p className="font-semibold border-b border-gray-600 pb-1 mb-1">{infoTitle}</p>
              )}
              {infoItems.map((item, index) => (
                <p key={index}>
                  {item.label}: <span className="font-bold">{item.value}</span>
                </p>
              ))}
            </div>
          </div>
        </div>
      )}
      
      <p className="text-xs text-gray-500">{label}</p>
      <div className="flex items-center space-x-2">
        <Icon className={`w-6 h-6 ${colors.icon}`} />
        <span className={`text-2xl font-bold ${colors.text}`}>
          {value !== null ? (
            <>
              {value.toFixed(1)}
              <span className="text-sm font-normal ml-1">{unit}</span>
              {secondaryValue !== null && secondaryUnit && (
                <>
                  <span className="text-sm font-normal mx-1">/</span>
                  {secondaryValue!.toFixed(1)}
                  <span className="text-sm font-normal ml-0.5">{secondaryUnit}</span>
                </>
              )}
            </>
          ) : (
            '—'
          )}
        </span>
      </div>
      {subtext && (
        <p className="text-xs text-gray-500">{subtext}</p>
      )}
    </div>
  );
}