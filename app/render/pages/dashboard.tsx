"use client";
import React, { useEffect, useState } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import styles from '../styles/dashboard.module.css'
import LocalFileManager from "@/components/Dashboard/LocalFileManager"


interface DashboardCardProps {
  title: string;
  value: string;
  icon: React.ElementType;
}

function DashboardCard({ title, value, icon: Icon }: DashboardCardProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium">{title}</CardTitle>
        {/*@ts-ignore*/}
        <Icon className="h-4 w-4 text-muted-foreground" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold">{value}</div>
      </CardContent>
    </Card>
  );
}

const Dashboard = () => {
  const [isElectron, setIsElectron] = useState(false);

  useEffect(() => {
    if (typeof window !== 'undefined' && window.electron) {
      setIsElectron(true);
    }
  }, []);

  return (
    <div className={styles['dashboard-container']}>
      <ScrollArea className="h-full w-full flex-1">
        <div className={styles['dashboard-grid']}>
          {isElectron && (
            <div className={styles.widget}>
              <LocalFileManager />
            </div>
          )}
        </div>
      </ScrollArea>
    
    </div>
  )
}

export default Dashboard
