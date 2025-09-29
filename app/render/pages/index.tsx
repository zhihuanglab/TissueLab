"use client";
import { Outfit } from "next/font/google";
import { useRouter } from "next/router";
import React, { useEffect, useState } from "react";

const outfit = Outfit({ subsets: ["latin"] });

export default function Home() {
  const router = useRouter();

  useEffect(() => {
    router.push("/dashboard");
  }, [router]);


  return (
    <div className="min-h-[calc(100vh-50px)] flex flex-col relative bg-white items-center justify-center">
      <div id="loading" aria-label="Loading..." role="status" className="flex flex-col items-center space-x-2">
          <svg className="h-40 w-40 animate-spin stroke-gray-400" viewBox="0 0 256 256">
            <line x1="128" y1="32" x2="128" y2="64" strokeLinecap="round" strokeLinejoin="round"
                  strokeWidth="24"></line>
            <line x1="195.9" y1="60.1" x2="173.3" y2="82.7" strokeLinecap="round" strokeLinejoin="round"
                  strokeWidth="24"></line>
            <line x1="224" y1="128" x2="192" y2="128" strokeLinecap="round" strokeLinejoin="round" strokeWidth="24">
            </line>
            <line x1="195.9" y1="195.9" x2="173.3" y2="173.3" strokeLinecap="round" strokeLinejoin="round"
                  strokeWidth="24"></line>
            <line x1="128" y1="224" x2="128" y2="192" strokeLinecap="round" strokeLinejoin="round" strokeWidth="24">
            </line>
            <line x1="60.1" y1="195.9" x2="82.7" y2="173.3" strokeLinecap="round" strokeLinejoin="round"
                  strokeWidth="24"></line>
            <line x1="32" y1="128" x2="64" y2="128" strokeLinecap="round" strokeLinejoin="round"
                  strokeWidth="24"></line>
            <line x1="60.1" y1="60.1" x2="82.7" y2="82.7" strokeLinecap="round" strokeLinejoin="round"
                  strokeWidth="24">
            </line>
          </svg>
          <span className="text-4xl font-medium text-gray-400">Loading...</span>
        </div>
    </div>
  );
}
