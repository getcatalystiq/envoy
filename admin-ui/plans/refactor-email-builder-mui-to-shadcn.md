# Migration Plan: Email Builder MUI to shadcn/ui + Tailwind

## Overview

Migrate the email builder component from Material UI (MUI) to shadcn/ui and Tailwind CSS. The project already has shadcn/ui and Tailwind configured and used elsewhere, so this migration aligns the email builder with the rest of the application's UI library.

## Current State

### MUI Dependencies in Email Builder

**63 total MUI import statements** across the email builder codebase:
- 40 imports from `@mui/material`
- 22 imports from `@mui/icons-material`
- 1 import from `@mui/material/styles`

### MUI Components Used (by frequency)

| Component | Count | shadcn/ui Equivalent |
|-----------|-------|---------------------|
| Stack | 14 | `flex` div with Tailwind |
| Box | 11 | `div` with Tailwind |
| ToggleButton | 8 | Custom `ToggleGroup` (Radix) |
| IconButton | 7 | `Button` variant="ghost" size="icon" |
| Typography | 6 | Native HTML elements with Tailwind |
| Tooltip | 6 | `Tooltip` (add to shadcn) |
| InputLabel | 5 | `Label` |
| Button | 4 | `Button` |
| TextField | 3 | `Input` |
| ToggleButtonGroup | 2 | `ToggleGroup` (add to shadcn) |
| Tabs/Tab | 4 | `Tabs` (already exists) |
| Menu | 2 | `DropdownMenu` |
| Drawer | 2 | `Sheet` (add to shadcn) |
| ButtonBase | 2 | `button` with Tailwind |
| Slider | 1 | `Slider` (add to shadcn) |
| Switch | 1 | `Switch` (add to shadcn) |
| Snackbar | 1 | `toast` (sonner) |
| Paper | 1 | `Card` |
| MenuItem | 1 | `DropdownMenuItem` |
| Link | 1 | Native `a` with Tailwind |
| FormControlLabel | 1 | Custom with `Label` |
| Fade | 1 | CSS transitions |
| Divider | 1 | `Separator` (add to shadcn) |

### MUI Icons Used (26 total)

Icons will be replaced with [Lucide React](https://lucide.dev/) icons, which is the standard for shadcn/ui projects.

| MUI Icon | Lucide Equivalent |
|----------|-------------------|
| AddOutlined | `Plus` |
| CloseOutlined | `X` |
| DeleteOutlined | `Trash2` |
| EditOutlined | `Pencil` |
| CodeOutlined | `Code` |
| PreviewOutlined | `Eye` |
| DataObjectOutlined | `Braces` |
| FileUploadOutlined | `Upload` |
| FileDownloadOutlined | `Download` |
| ContentCopyOutlined | `Copy` |
| MonitorOutlined | `Monitor` |
| PhoneIphoneOutlined | `Smartphone` |
| MenuOutlined | `Menu` |
| FirstPageOutlined | `ChevronFirst` |
| LastPageOutlined | `ChevronLast` |
| HeightOutlined | `ArrowUpDown` |
| TextFieldsOutlined | `Type` |
| RoundedCornerOutlined | `Square` (or custom) |
| AspectRatioOutlined | `Maximize2` |
| FormatAlignLeftOutlined | `AlignLeft` |
| FormatAlignCenterOutlined | `AlignCenter` |
| FormatAlignRightOutlined | `AlignRight` |
| ArrowUpwardOutlined | `ArrowUp` |
| ArrowDownwardOutlined | `ArrowDown` |
| AppRegistrationOutlined | `Settings` |
| IosShareOutlined | `Share` |

### Files to Modify

1. **Theme file**: `src/components/email-builder/theme.ts` - Delete after migration
2. **App components**:
   - `src/components/email-builder/App/index.tsx`
   - `src/components/email-builder/App/InspectorDrawer/*`
   - `src/components/email-builder/App/SamplesDrawer/*`
   - `src/components/email-builder/App/TemplatePanel/*`

### Existing shadcn/ui Components

Already available in `src/components/ui/`:
- `Button`, `Input`, `Label`, `Textarea`
- `Card`
- `Badge`
- `Alert`
- `Checkbox`
- `Dialog`
- `DropdownMenu`
- `Select`
- `Tabs`
- `TagInput`

## Migration Strategy

### Phase 1: Add Missing shadcn/ui Components

Add these components using the shadcn CLI:

```bash
npx shadcn@latest add tooltip
npx shadcn@latest add toggle-group
npx shadcn@latest add sheet
npx shadcn@latest add slider
npx shadcn@latest add switch
npx shadcn@latest add separator
npx shadcn@latest add sonner
```

### Phase 2: Create Utility Components

Create helper components to replace common MUI patterns:

1. **Stack replacement** - Use Tailwind `flex` classes directly
2. **Box replacement** - Use `div` with Tailwind classes
3. **Typography replacement** - Use semantic HTML with Tailwind

### Phase 3: Migrate Input Components (Sidebar Panels)

Start with the input helpers as they are used throughout:

1. `SliderInput.tsx` - Replace MUI Slider
2. `RadioGroupInput.tsx` - Replace ToggleButtonGroup
3. `BooleanInput.tsx` - Replace Switch
4. `TextInput.tsx` - Replace TextField
5. `TextDimensionInput.tsx` - Replace TextField
6. `ColorInput/*` - Replace Menu, ButtonBase
7. `PaddingInput.tsx` - Replace InputLabel, Stack
8. `TextAlignInput.tsx` - Replace ToggleButton
9. `FontWeightInput.tsx` - Replace ToggleButton
10. `FontSizeInput.tsx` - Replace InputLabel, Stack
11. `FontFamily.tsx` - Replace MenuItem, TextField

### Phase 4: Migrate Sidebar Panel Components

1. `BaseSidebarPanel.tsx` - Replace Box, Stack, Typography
2. `SingleStylePropertyPanel.tsx` - Replace icons
3. Individual sidebar panels (Avatar, Button, Columns, Divider, etc.)

### Phase 5: Migrate Drawer Components

1. `InspectorDrawer/index.tsx` - Replace Drawer, Tabs
2. `SamplesDrawer/index.tsx` - Replace Drawer, Stack, Typography
3. `ToggleInspectorPanelButton.tsx` - Replace IconButton
4. `ToggleSamplesPanelButton.tsx` - Replace IconButton
5. `SidebarButton.tsx` - Replace Button

### Phase 6: Migrate Template Panel

1. `TemplatePanel/index.tsx` - Replace Box, Stack, ToggleButton
2. `MainTabsGroup.tsx` - Replace Tabs
3. `ShareButton.tsx` - Replace IconButton, Snackbar, Tooltip
4. `ImportJson/*` - Replace Dialog components

### Phase 7: Migrate App Root

1. `App/index.tsx` - Replace Stack, useTheme

### Phase 8: Cleanup

1. Delete `theme.ts`
2. Remove MUI dependencies from package.json
3. Run build to verify no MUI imports remain
4. Test all email builder functionality

## Component Migration Patterns

### Stack → Tailwind Flex

```tsx
// Before (MUI)
<Stack direction="row" spacing={2} alignItems="center">
  {children}
</Stack>

// After (Tailwind)
<div className="flex flex-row gap-2 items-center">
  {children}
</div>
```

### Box → div with Tailwind

```tsx
// Before (MUI)
<Box sx={{ p: 2, bgcolor: 'grey.100' }}>
  {children}
</Box>

// After (Tailwind)
<div className="p-4 bg-gray-100">
  {children}
</div>
```

### Typography → Semantic HTML

```tsx
// Before (MUI)
<Typography variant="h6">Title</Typography>
<Typography variant="body2" color="text.secondary">
  Description
</Typography>

// After (Tailwind)
<h6 className="text-base font-medium">Title</h6>
<p className="text-sm text-muted-foreground">Description</p>
```

### ToggleButton → Toggle from shadcn

```tsx
// Before (MUI)
<ToggleButtonGroup value={value} onChange={handleChange}>
  <ToggleButton value="left"><AlignLeft /></ToggleButton>
  <ToggleButton value="center"><AlignCenter /></ToggleButton>
</ToggleButtonGroup>

// After (shadcn)
<ToggleGroup type="single" value={value} onValueChange={handleChange}>
  <ToggleGroupItem value="left"><AlignLeft className="h-4 w-4" /></ToggleGroupItem>
  <ToggleGroupItem value="center"><AlignCenter className="h-4 w-4" /></ToggleGroupItem>
</ToggleGroup>
```

### IconButton → Button ghost

```tsx
// Before (MUI)
<IconButton onClick={handleClick}>
  <MenuIcon />
</IconButton>

// After (shadcn)
<Button variant="ghost" size="icon" onClick={handleClick}>
  <Menu className="h-4 w-4" />
</Button>
```

### Drawer → Sheet

```tsx
// Before (MUI)
<Drawer anchor="right" open={open} onClose={onClose}>
  {children}
</Drawer>

// After (shadcn)
<Sheet open={open} onOpenChange={setOpen}>
  <SheetContent side="right">
    {children}
  </SheetContent>
</Sheet>
```

### TextField → Input

```tsx
// Before (MUI)
<TextField
  label="Name"
  value={value}
  onChange={(e) => setValue(e.target.value)}
  size="small"
/>

// After (shadcn)
<div className="space-y-1.5">
  <Label htmlFor="name">Name</Label>
  <Input
    id="name"
    value={value}
    onChange={(e) => setValue(e.target.value)}
  />
</div>
```

### Slider → shadcn Slider

```tsx
// Before (MUI)
<Slider
  value={value}
  onChange={(_, v) => setValue(v)}
  min={0}
  max={100}
/>

// After (shadcn)
<Slider
  value={[value]}
  onValueChange={(v) => setValue(v[0])}
  min={0}
  max={100}
/>
```

### Menu → DropdownMenu

```tsx
// Before (MUI)
<Menu anchorEl={anchorEl} open={open} onClose={handleClose}>
  <MenuItem onClick={handleOption1}>Option 1</MenuItem>
  <MenuItem onClick={handleOption2}>Option 2</MenuItem>
</Menu>

// After (shadcn)
<DropdownMenu open={open} onOpenChange={setOpen}>
  <DropdownMenuContent>
    <DropdownMenuItem onClick={handleOption1}>Option 1</DropdownMenuItem>
    <DropdownMenuItem onClick={handleOption2}>Option 2</DropdownMenuItem>
  </DropdownMenuContent>
</DropdownMenu>
```

## Color/Theme Migration

### Current MUI Theme Colors

```ts
// MUI theme.ts
brand: {
  navy: '#212443',
  blue: '#0079CC',
  green: '#1F8466',
  red: '#E81212',
  yellow: '#F6DC9F',
  purple: '#6C0E7C',
  brown: '#CC996C',
}
```

### Tailwind CSS Variables (in globals.css)

Add these CSS variables to maintain brand colors:

```css
:root {
  --brand-navy: 212 22% 20%;
  --brand-blue: 203 100% 40%;
  --brand-green: 162 61% 32%;
  --brand-red: 0 87% 49%;
  --brand-yellow: 41 83% 79%;
  --brand-purple: 291 78% 27%;
  --brand-brown: 28 47% 61%;
}
```

And extend tailwind.config:

```ts
colors: {
  brand: {
    navy: 'hsl(var(--brand-navy))',
    blue: 'hsl(var(--brand-blue))',
    green: 'hsl(var(--brand-green))',
    red: 'hsl(var(--brand-red))',
    yellow: 'hsl(var(--brand-yellow))',
    purple: 'hsl(var(--brand-purple))',
    brown: 'hsl(var(--brand-brown))',
  },
}
```

## Testing Checklist

After migration, verify:

- [ ] Inspector drawer opens/closes correctly
- [ ] All sidebar panels render properly
- [ ] Input controls (slider, toggle, color picker) work
- [ ] Samples drawer functions
- [ ] Template panel tabs work
- [ ] Desktop/mobile preview toggle works
- [ ] Import/export JSON works
- [ ] Share button and toast notifications work
- [ ] All icons display correctly
- [ ] Keyboard navigation still works
- [ ] No console errors
- [ ] Build succeeds with no MUI imports

## Risks and Considerations

1. **Styling differences**: shadcn components may have slightly different default styles
2. **Behavior differences**: Some MUI-specific behaviors may need custom implementation
3. **Accessibility**: Ensure ARIA attributes are maintained during migration
4. **Performance**: Verify no performance regression from component changes

## Estimated Scope

- **Files to modify**: ~25 files
- **New shadcn components to add**: 7
- **MUI imports to remove**: 63
- **Icons to replace**: 26

## References

- [shadcn/ui Documentation](https://ui.shadcn.com/)
- [Tailwind CSS Documentation](https://tailwindcss.com/docs)
- [Lucide Icons](https://lucide.dev/icons)
- [Radix UI Primitives](https://www.radix-ui.com/primitives)
