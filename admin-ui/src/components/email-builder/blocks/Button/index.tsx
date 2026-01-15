import { z } from 'zod';
import { COLOR_SCHEMA, PADDING_SCHEMA, FONT_FAMILY_SCHEMA, getFontFamily, getPadding } from '../shared';

export const ButtonPropsSchema = z.object({
  style: z.object({
    backgroundColor: COLOR_SCHEMA,
    fontSize: z.number().min(0).optional().nullable(),
    fontFamily: FONT_FAMILY_SCHEMA,
    fontWeight: z.enum(['bold', 'normal']).optional().nullable(),
    textAlign: z.enum(['left', 'center', 'right']).optional().nullable(),
    padding: PADDING_SCHEMA,
  }).optional().nullable(),
  props: z.object({
    buttonBackgroundColor: COLOR_SCHEMA,
    buttonStyle: z.enum(['rectangle', 'pill', 'rounded']).optional().nullable(),
    buttonTextColor: COLOR_SCHEMA,
    fullWidth: z.boolean().optional().nullable(),
    size: z.enum(['x-small', 'small', 'large', 'medium']).optional().nullable(),
    text: z.string().optional().nullable(),
    url: z.string().optional().nullable(),
  }).optional().nullable(),
});

export type ButtonProps = z.infer<typeof ButtonPropsSchema>;

export const ButtonPropsDefaults = {
  text: '',
  url: '',
  fullWidth: false,
  size: 'medium' as const,
  buttonStyle: 'rounded' as const,
  buttonTextColor: '#FFFFFF',
  buttonBackgroundColor: '#999999',
};

function getRoundedCorners(props: ButtonProps['props']): number | undefined {
  const buttonStyle = props?.buttonStyle ?? ButtonPropsDefaults.buttonStyle;
  switch (buttonStyle) {
    case 'rectangle':
      return undefined;
    case 'pill':
      return 64;
    case 'rounded':
    default:
      return 4;
  }
}

function getButtonSizePadding(props: ButtonProps['props']): [number, number] {
  const size = props?.size ?? ButtonPropsDefaults.size;
  switch (size) {
    case 'x-small':
      return [4, 8];
    case 'small':
      return [8, 12];
    case 'large':
      return [16, 32];
    case 'medium':
    default:
      return [12, 20];
  }
}

export function Button({ style, props }: ButtonProps) {
  const text = props?.text ?? ButtonPropsDefaults.text;
  const url = props?.url ?? ButtonPropsDefaults.url;
  const fullWidth = props?.fullWidth ?? ButtonPropsDefaults.fullWidth;
  const buttonTextColor = props?.buttonTextColor ?? ButtonPropsDefaults.buttonTextColor;
  const buttonBackgroundColor = props?.buttonBackgroundColor ?? ButtonPropsDefaults.buttonBackgroundColor;

  const padding = getButtonSizePadding(props);
  const textRaise = (padding[1] * 2 * 3) / 4;

  const wrapperStyle = {
    backgroundColor: style?.backgroundColor ?? undefined,
    textAlign: style?.textAlign ?? undefined,
    padding: getPadding(style?.padding),
  };

  const linkStyle = {
    color: buttonTextColor,
    fontSize: style?.fontSize ?? 16,
    fontFamily: getFontFamily(style?.fontFamily),
    fontWeight: style?.fontWeight ?? 'bold',
    backgroundColor: buttonBackgroundColor,
    borderRadius: getRoundedCorners(props),
    display: fullWidth ? 'block' : 'inline-block',
    padding: `${padding[0]}px ${padding[1]}px`,
    textDecoration: 'none',
  };

  return (
    <div style={wrapperStyle}>
      <a href={url} style={linkStyle} target="_blank">
        <span
          dangerouslySetInnerHTML={{
            __html: `<!--[if mso]><i style="letter-spacing: ${padding[1]}px;mso-font-width:-100%;mso-text-raise:${textRaise}" hidden>&nbsp;</i><![endif]-->`,
          }}
        />
        <span>{text}</span>
        <span
          dangerouslySetInnerHTML={{
            __html: `<!--[if mso]><i style="letter-spacing: ${padding[1]}px;mso-font-width:-100%" hidden>&nbsp;</i><![endif]-->`,
          }}
        />
      </a>
    </div>
  );
}
