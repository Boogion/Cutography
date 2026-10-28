/* palettes.js — default paper packs.
   Every value here is a starting point. The Hello Hobby pads do not publish
   sheet colors, so these hexes are approximations; use "Sample from photo"
   in the app to replace them with colors measured from your own sheets. */
(function (root) {
  'use strict';

  // Design Space material suggestions are free text; edit them to match
  // whatever setting cuts cleanly on your Joy Xtra.
  const DEFAULT_PACKS = [
    {
      id: 'hh-light-tones',
      name: 'Hello Hobby Light Tones',
      finish: 'smooth',
      weight: '65 lb (176 gsm)',
      material: 'Medium Cardstock - 80 lb',
      sheetW: 8.5, sheetH: 11,
      colors: [
        { id: 'white',    name: 'White',        hex: '#f7f6f2', on: true },
        { id: 'ivory',    name: 'Ivory',        hex: '#f3ead3', on: true },
        { id: 'blush',    name: 'Blush Pink',   hex: '#f4cdd4', on: true },
        { id: 'peach',    name: 'Peach',        hex: '#f8d2b4', on: true },
        { id: 'butter',   name: 'Butter Yellow',hex: '#f8ea9e', on: true },
        { id: 'mint',     name: 'Mint',         hex: '#c9e8cf', on: true },
        { id: 'sky',      name: 'Sky Blue',     hex: '#bcd9ee', on: true },
        { id: 'lavender', name: 'Lavender',     hex: '#d9cde9', on: true },
        { id: 'aqua',     name: 'Light Aqua',   hex: '#bfe4e2', on: true },
        { id: 'gray',     name: 'Light Gray',   hex: '#d6d6d4', on: true }
      ]
    },
    {
      id: 'hh-holo-foil',
      name: 'Hello Hobby Holographic Foil',
      finish: 'holographic foil',
      weight: 'foil cardstock',
      material: 'Foil Poster Board / Heavy Cardstock (test first)',
      sheetW: 8.5, sheetH: 11,
      colors: [
        { id: 'silver',   name: 'Silver Holo',    hex: '#cfd3da', on: true },
        { id: 'gold',     name: 'Gold Holo',      hex: '#d8b85a', on: true },
        { id: 'rose',     name: 'Rose Gold Holo', hex: '#d9a28f', on: true },
        { id: 'blue',     name: 'Blue Holo',      hex: '#6f93cf', on: true },
        { id: 'pink',     name: 'Pink Holo',      hex: '#d989b8', on: true },
        { id: 'green',    name: 'Green Holo',     hex: '#7cbf8e', on: true }
      ]
    },
    {
      id: 'hh-greens',
      name: 'Hello Hobby Greens',
      finish: 'smooth',
      weight: '65 lb (176 gsm)',
      material: 'Medium Cardstock - 80 lb',
      sheetW: 8.5, sheetH: 11,
      colors: [
        { id: 'pastel', name: 'Pastel Green', hex: '#cfe6c4', on: true },
        { id: 'sage',   name: 'Sage Green',   hex: '#9bb493', on: true },
        { id: 'grass',  name: 'Grass Green',  hex: '#5aa33f', on: true },
        { id: 'olive',  name: 'Olive',        hex: '#7d8a3c', on: true },
        { id: 'pine',   name: 'Pine Green',   hex: '#2f6b45', on: true },
        { id: 'dark',   name: 'Dark Green',   hex: '#1d4430', on: true }
      ]
    },
    {
      id: 'hh-primaries',
      name: 'Hello Hobby Primaries (textured)',
      finish: 'textured',
      weight: '65 lb (176 gsm)',
      material: 'Medium Cardstock - 80 lb',
      sheetW: 8.5, sheetH: 11,
      colors: [
        { id: 'red',    name: 'Red',    hex: '#c8242c', on: true },
        { id: 'orange', name: 'Orange', hex: '#ec7b22', on: true },
        { id: 'yellow', name: 'Yellow', hex: '#f6d035', on: true },
        { id: 'green',  name: 'Green',  hex: '#2f8f3e', on: true },
        { id: 'blue',   name: 'Blue',   hex: '#1f4fa3', on: true },
        { id: 'purple', name: 'Purple', hex: '#6b3b98', on: true },
        { id: 'black',  name: 'Black',  hex: '#1c1c1e', on: true },
        { id: 'white',  name: 'White',  hex: '#f8f8f6', on: true }
      ]
    }
  ];

  const FINISHES = ['smooth', 'textured', 'foil', 'holographic foil', 'glitter', 'vellum', 'other'];

  // Cricut Joy Xtra working limits (inches). Editable in the app.
  const MACHINE = {
    name: 'Cricut Joy Xtra',
    matW: 8.2, matH: 10.7,     // 8.5 x 11 cardstock on the 8.5 x 12 mat
    matMaxW: 8.2, matMaxH: 11.7,   // Cricut's maximum cut size on a Joy Xtra machine mat; wider designs are Smart Materials only
    ptcW: 7.44, ptcH: 9.94     // Print Then Cut on US Letter
  };

  root.CutPalettes = { DEFAULT_PACKS, FINISHES, MACHINE };
})(typeof self !== 'undefined' ? self : this);
