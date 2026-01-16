import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';

import { useSamplesDrawerOpen } from '../../documents/editor/EditorContext';

import SidebarButton from './SidebarButton';
import logo from './waypoint.svg';

export const SAMPLES_DRAWER_WIDTH = 240;

export default function SamplesDrawer() {
  const samplesDrawerOpen = useSamplesDrawerOpen();

  return (
    <div
      className={cn(
        'fixed top-[102px] left-0 h-[calc(100%-102px)] bg-background border-r border-border transition-all duration-200 overflow-hidden',
        samplesDrawerOpen ? 'w-[240px]' : 'w-0'
      )}
    >
      <div className="flex flex-col justify-between h-full py-1 px-2 w-[240px]">
        <div className="flex flex-col gap-4">
          <h1 className="text-lg font-semibold p-1.5">EmailBuilder.js</h1>

          <div className="flex flex-col items-start">
            <SidebarButton href="#">Empty</SidebarButton>
            <SidebarButton href="#sample/welcome">Welcome email</SidebarButton>
            <SidebarButton href="#sample/one-time-password">One-time passcode (OTP)</SidebarButton>
            <SidebarButton href="#sample/reset-password">Reset password</SidebarButton>
            <SidebarButton href="#sample/order-ecomerce">E-commerce receipt</SidebarButton>
            <SidebarButton href="#sample/subscription-receipt">Subscription receipt</SidebarButton>
            <SidebarButton href="#sample/reservation-reminder">Reservation reminder</SidebarButton>
            <SidebarButton href="#sample/post-metrics-report">Post metrics</SidebarButton>
            <SidebarButton href="#sample/respond-to-message">Respond to inquiry</SidebarButton>
          </div>

          <Separator />

          <div className="flex flex-col">
            <Button variant="ghost" size="sm" className="justify-start" asChild>
              <a href="https://www.usewaypoint.com/open-source/emailbuilderjs" target="_blank" rel="noopener noreferrer">
                Learn more
              </a>
            </Button>
            <Button variant="ghost" size="sm" className="justify-start" asChild>
              <a href="https://github.com/usewaypoint/email-builder-js" target="_blank" rel="noopener noreferrer">
                View on GitHub
              </a>
            </Button>
          </div>
        </div>
        <div className="flex flex-col gap-4 px-1.5 py-6">
          <a href="https://usewaypoint.com?utm_source=emailbuilderjs" target="_blank" rel="noopener noreferrer" className="leading-none">
            <img src={logo} width={32} alt="Waypoint logo" />
          </a>
          <div>
            <p className="text-xs uppercase tracking-wider text-muted-foreground mb-1">Looking to send emails?</p>
            <p className="text-sm text-muted-foreground">
              Waypoint is an end-to-end email API with a &apos;pro&apos; version of this template builder with dynamic
              variables, loops, conditionals, drag and drop, layouts, and more.
            </p>
          </div>
          <Button asChild>
            <a href="https://usewaypoint.com?utm_source=emailbuilderjs" target="_blank" rel="noopener noreferrer">
              Learn more
            </a>
          </Button>
        </div>
      </div>
    </div>
  );
}
