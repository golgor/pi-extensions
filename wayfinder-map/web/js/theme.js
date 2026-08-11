// Status palette: star core/glow colours, core radius and glow radius.
export const COL = {
  resolved:     {core: "#b9d6c4", glow: "#5b9077", r: 5.4, gr: 24},
  frontier:     {core: "#8ad8ff", glow: "#2f9be0", r: 8.1, gr: 49},
  claimed:      {core: "#ffd873", glow: "#ffb020", r: 7.2, gr: 36},
  blocked:      {core: "#e2c3c3", glow: "#9a6f6f", r: 4.5, gr: 20},
  out_of_scope: {core: "#7d7789", glow: "#4a4550", r: 4.5, gr: 18}
};

export const LABELCOL = {
  resolved: "#a2c1ac", frontier: "#b3e5ff", claimed: "#ffe6a0",
  blocked: "#d0b3b3", out_of_scope: "#8a8496"
};

export function col(n) { return COL[n.status] || COL.blocked; }
