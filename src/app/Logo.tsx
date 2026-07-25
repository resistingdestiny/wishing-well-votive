export function LogoMark({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={(size * 32) / 24}
      viewBox="0 0 24 32"
      fill="none"
      aria-hidden="true"
    >
      <g
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {}
        <path d="M12 2 C10 4.8 8.2 6.6 8.2 9.2 a3.8 3.8 0 0 0 7.6 0 C15.8 6.6 14 4.8 12 2 Z" />
        {}
        <path d="M12 10.5 V19" />
        {}
        <path d="M4.2 16.9 A9 2.8 0 0 1 19.8 16.9" />
        <path d="M3 18 A9 2.8 0 0 0 21 18" />
        {}
        <path d="M3 18 V23" />
        <path d="M21 18 V23" />
        {}
        <path d="M3 23 A9 2.8 0 0 0 10 25.72" />
        <path d="M14 25.72 A9 2.8 0 0 0 21 23" />
      </g>
      <g fill="currentColor">
        <circle cx="12" cy="27.6" r="0.95" />
        <circle cx="12" cy="29.5" r="0.85" opacity="0.7" />
        <circle cx="12" cy="31.2" r="0.75" opacity="0.45" />
      </g>
    </svg>
  );
}
