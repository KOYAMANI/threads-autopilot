/**
 * アイコン（インライン SVG）。Webフォントも追加の依存も足さない。
 * すべて 24×24・`currentColor`・`stroke-width 1.75` で揃える。
 */
type Props = { size?: number };

function Svg({ size = 22, children }: Props & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export const MenuIcon = (p: Props) => (
  <Svg {...p}>
    <path d="M3 6h18M3 12h18M3 18h18" />
  </Svg>
);

export const PlusIcon = (p: Props) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

export const HomeIcon = (p: Props) => (
  <Svg {...p}>
    <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z" />
  </Svg>
);

export const PenIcon = (p: Props) => (
  <Svg {...p}>
    <path d="M4 20h4l10-10a2.8 2.8 0 0 0-4-4L4 16z" />
  </Svg>
);

export const StackIcon = (p: Props) => (
  <Svg {...p}>
    <rect x="3" y="4" width="18" height="5" rx="1.5" />
    <rect x="3" y="12" width="18" height="5" rx="1.5" />
    <path d="M6 20h12" />
  </Svg>
);

export const PlaneIcon = (p: Props) => (
  <Svg {...p}>
    <path d="M21 3 3 10.5l6.5 2.5L12 20z" />
    <path d="M9.5 13 21 3" />
  </Svg>
);

export const GearIcon = (p: Props) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M12 3v2.2M12 18.8V21M4.2 7.5l1.9 1.1M17.9 15.4l1.9 1.1M4.2 16.5l1.9-1.1M17.9 8.6l1.9-1.1" />
  </Svg>
);

export const ChevronIcon = (p: Props) => (
  <Svg {...p}>
    <path d="m9 6 6 6-6 6" />
  </Svg>
);

export const DotsIcon = (p: Props) => (
  <Svg {...p}>
    <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    <circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none" />
  </Svg>
);
