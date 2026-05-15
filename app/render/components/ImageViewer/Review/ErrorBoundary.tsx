"use client";

import React, { Component, ErrorInfo, ReactNode } from "react";

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error('Active Learning Error:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return (
        this.props.fallback || (
          <div className="flex-1 p-4 border-l border-gray-200">
            <div className="bg-red-50 border border-red-200 rounded p-4">
              <h6 className="text-red-800 font-medium mb-2">
                Active Learning Error
              </h6>
              <p className="text-red-600 text-sm mb-2">
                An error occurred while loading the Active Learning panel.
              </p>
              {this.state.error && (
                <details className="text-xs text-red-500">
                  <summary className="cursor-pointer">Error details</summary>
                  <pre className="mt-2 whitespace-pre-wrap">
                    {this.state.error.message}
                  </pre>
                </details>
              )}
              <button 
                className="mt-3 px-3 py-1 bg-red-600 text-white text-sm rounded hover:bg-red-700"
                onClick={() => this.setState({ hasError: false, error: undefined })}
              >
                Retry
              </button>
            </div>
          </div>
        )
      );
    }

    return this.props.children;
  }
}

export default ErrorBoundary;