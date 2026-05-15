import React from 'react';

type PageLoadingProps = {
  message?: string;
  subtitle?: string;
  pageTitle?: string;
  spinnerColor?: string;
  spinnerSize?: number;
  fullPage?: boolean;
  className?: string;
  ringThickness?: number;
};

type InlineSpinnerProps = {
  color?: string;
  size?: number;
  ringThickness?: number;
  className?: string;
};

export const InlineSpinner = ({
  color = "#6352a3",
  size = 16,
  ringThickness,
  className = ""
}: InlineSpinnerProps) => {
  const thickness = typeof ringThickness === 'number' && !isNaN(ringThickness)
    ? ringThickness
    : Math.max(3, Math.round(size * 0.2));
  return (
    <span
      className={`inline-block animate-spin rounded-full ${className}`}
      style={{
        width: `${size}px`,
        height: `${size}px`,
        border: `${thickness}px solid rgba(99, 82, 163, 0.15)`,
        borderTopColor: color,
      }}
    />
  );
};

export default function PageLoading({
  message = "Loading...",
  subtitle,
  pageTitle,
  spinnerColor = "#6352a3",
  spinnerSize = 48,
  fullPage = true,
  className = "",
  ringThickness
}: PageLoadingProps) {
  const thickness = typeof ringThickness === 'number' && !isNaN(ringThickness)
    ? ringThickness
    : Math.max(6, Math.round(spinnerSize * 0.35));
  const content = (
    <div className="flex flex-col items-center justify-center py-32">
      <InlineSpinner color={spinnerColor} size={spinnerSize} ringThickness={thickness} className="mb-4" />
      
      <p className="text-lg text-gray-600 font-medium">
        {message}
      </p>
      
      {subtitle && (
        <p className="text-sm text-gray-400 mt-2">
          {subtitle}
        </p>
      )}
    </div>
  );

  if (!fullPage) {
    return <div className={className}>{content}</div>;
  }

  return (
    <div className={`bg-gray-50 min-h-screen ${className}`}>
      <div className="container mx-auto px-4 py-6 pb-12 max-w-7xl h-full">
        {pageTitle && (
          <div className="mb-6">
            <h1 className="text-3xl font-bold text-gray-900 mb-2">
              {pageTitle}
            </h1>
          </div>
        )}
        
        {content}
      </div>
    </div>
  );
}

