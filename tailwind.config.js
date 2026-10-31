/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    './pages/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './app/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          purple: '#7028E4',
          'purple-light': '#9055F6',
          'purple-dark': '#5017B0',
          pink: '#FF5C9A',
          'pink-light': '#FF80B2',
          'pink-dark': '#E03678',
          blue: '#36C5F0',
          'blue-light': '#6AD7F7',
          navy: '#100D24',
          'navy-light': '#181438',
          card: '#211B3D',
          'card-hover': '#2C2452',
          'card-border': 'rgba(255, 255, 255, 0.1)',
        },
      },
      fontFamily: {
        sans: ['var(--font-outfit)', 'Inter', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        'glow-purple': '0 0 25px rgba(112, 40, 228, 0.45)',
        'glow-pink': '0 0 25px rgba(255, 92, 154, 0.45)',
        'glow-blue': '0 0 25px rgba(54, 197, 240, 0.45)',
        'glow-gold': '0 0 25px rgba(255, 215, 0, 0.45)',
        'glass': '0 8px 32px 0 rgba(0, 0, 0, 0.37)',
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
        'couple-gradient': 'linear-gradient(135deg, #7028E4 0%, #FF5C9A 100%)',
        'couple-gradient-accent': 'linear-gradient(135deg, #7028E4 0%, #FF5C9A 50%, #36C5F0 100%)',
      },
      animation: {
        'float': 'float 4s ease-in-out infinite',
        'pulse-slow': 'pulse 3s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'heartbeat': 'heartbeat 1.5s ease-in-out infinite',
      },
      keyframes: {
        float: {
          '0%, 100%': { transform: 'translateY(0px)' },
          '50%': { transform: 'translateY(-10px)' },
        },
        heartbeat: {
          '0%, 100%': { transform: 'scale(1)' },
          '50%': { transform: 'scale(1.12)' },
        },
      },
    },
  },
  plugins: [],
}

