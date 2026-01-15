

import { Box, Drawer, Tab, Tabs } from '@mui/material';

import { setSidebarTab, useInspectorDrawerOpen, useSelectedSidebarTab } from '../../documents/editor/EditorContext';

import ConfigurationPanel from './ConfigurationPanel';
import StylesPanel from './StylesPanel';

export const INSPECTOR_DRAWER_WIDTH = 320;

export default function InspectorDrawer() {
  const selectedSidebarTab = useSelectedSidebarTab();
  const inspectorDrawerOpen = useInspectorDrawerOpen();

  const handleSidebarTabChange = (_: unknown, value: string) => {
    setSidebarTab(value as 'block-configuration' | 'styles');
  };

  const renderCurrentSidebarPanel = () => {
    switch (selectedSidebarTab) {
      case 'block-configuration':
        return <ConfigurationPanel />;
      case 'styles':
        return <StylesPanel />;
    }
  };

  return (
    <Drawer
      variant="persistent"
      anchor="right"
      open={inspectorDrawerOpen}
      sx={{
        width: inspectorDrawerOpen ? INSPECTOR_DRAWER_WIDTH : 0,
        '& .MuiDrawer-paper': {
          top: '89px', // Account for parent header
          height: 'calc(100% - 89px)',
          right: '23px',
          borderLeft: 1,
          borderColor: 'divider',
        },
      }}
    >
      <Box sx={{ width: INSPECTOR_DRAWER_WIDTH, height: '100%', display: 'flex', flexDirection: 'column' }}>
        <Tabs
          value={selectedSidebarTab}
          onChange={handleSidebarTabChange}
          sx={{
            borderBottom: 1,
            borderColor: 'divider',
            minHeight: 48,
            '& .MuiTab-root': {
              textTransform: 'none',
              fontSize: '0.875rem',
              minHeight: 48,
            },
          }}
        >
          <Tab label="Styles" value="styles" />
          <Tab label="Inspect" value="block-configuration" />
        </Tabs>
        <Box sx={{ flex: 1, overflow: 'auto' }}>
          {renderCurrentSidebarPanel()}
        </Box>
      </Box>
    </Drawer>
  );
}
