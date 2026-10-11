using System;
using System.Drawing;

namespace AntigravityHub
{
    internal static class TrayPlacement
    {
        public static Rectangle Calculate(Point cursor, Rectangle area, int width, int height)
        {
            const int margin = 8;
            width = Math.Clamp(width, 1, Math.Max(1, area.Width - margin * 2));
            height = Math.Clamp(height, 1, Math.Max(1, area.Height - margin * 2));
            int left = Math.Clamp(cursor.X - width / 2, area.Left + margin, Math.Max(area.Left + margin, area.Right - width - margin));
            int top = cursor.Y - height - margin;
            if (top < area.Top + margin) top = cursor.Y + margin;
            top = Math.Clamp(top, area.Top + margin, Math.Max(area.Top + margin, area.Bottom - height - margin));
            return new Rectangle(left, top, width, height);
        }
    }
}
