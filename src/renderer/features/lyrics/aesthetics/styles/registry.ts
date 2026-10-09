/*! Adapted from theaestheticslyrics, commit 499161944ce1af965398ce038073dcd890bf5f66. Copyright (c) 2026 darshanseenivasakumar. MIT; see ./LICENSE. */
import type { StyleId } from '../types';
import type { StageStyle } from './types';

import { createFisheye } from './fisheye';
import { createShip } from './ship';
import { createVisual } from './visual';

export function createStyle(id: StyleId): StageStyle {
    switch (id) {
        case 'fisheye':
            return createFisheye(false);
        case 'fisheye-visual':
            return createFisheye(true);
        case 'ship':
            return createShip();
        case 'ship-visual':
            return createShip(true);
        case 'visual':
            return createVisual();
    }
}
