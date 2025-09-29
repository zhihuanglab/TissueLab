import React, { useState } from 'react';
import { CNav as CNavBase, CNavItem as CNavItemBase, CNavLink as CNavLinkBase, CTabContent as CTabContentBase, CTabPane as CTabPaneBase } from '@coreui/react';
// TODO: Search functionality - commented out for future use
// import SearchTab from './Search';
import WSITab from './WSITab'; // Implied import for WSI tab
import CoPilotTab from './CoPilotTab'; // Add this import
import SidebarChat from "@/components/ImageViewer/Sidebar/SidebarChat";
import styles from './index.module.css'; // Updated import path

type TabConfig = {
  id: number;
  label: string;
  component: React.ComponentType;
};

const TABS: TabConfig[] = [
  { id: 0, label: 'Chat', component: SidebarChat },
  // TODO: Search functionality - commented out for future use
  // { id: 1, label: 'Search', component: SearchTab },
  { id: 2, label: 'Co-pilot', component: CoPilotTab }, // Add new tab
];

const CNav = CNavBase as any;
const CNavItem = CNavItemBase as any;
const CNavLink = CNavLinkBase as any;
const CTabContent = CTabContentBase as any;
const CTabPane = CTabPaneBase as any;

const SidebarTabs: React.FC = () => {
  const [activeTab, setActiveTab] = useState<number>(0);

  return (
    <div className="h-[calc(100vh-64px)] bg-gray-50">
			<div className="sticky top-0 z-40 bg-gray-50 border-b-0 border-gray-200 p-0 h-11">
				<CNav variant="tabs" className="border-none px-1 pt-1 flex gap-1" role="tablist">
					{TABS.map(({ id, label }, index) => (
						<React.Fragment key={id}>
							<CNavItem className={styles['enhanced-nav-item']}>
								<CNavLink 
									active={activeTab === id}
									onClick={() => setActiveTab(id)}
									className={activeTab === id ? `${styles['active-link']} !bg-gray-50 !border-b-gray-50` : styles['inactive-link']}
									role="tab"
									aria-selected={activeTab === id}
									aria-controls={`tab-${id}`}
								>
									{label}
								</CNavLink>
							</CNavItem>
							{/* {index < TABS.length - 1 && (
								<div className={styles['tab-divider']} />
							)} */}
						</React.Fragment>
					))}
				</CNav>
			</div>
			<CTabContent>
				{TABS.map(({ id, component: Component }) => (
					<CTabPane 
						visible={activeTab === id} 
						key={id}
						id={`tab-${id}`}
						role="tabpanel"
						className="h-full"
					>
						{/* @ts-ignore */}
						<Component />
					</CTabPane>
				))}
			</CTabContent>
    </div>
  );
};

export default SidebarTabs;
