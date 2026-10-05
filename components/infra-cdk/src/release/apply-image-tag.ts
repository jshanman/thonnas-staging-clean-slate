export const APPLY_IMAGE_TAG_WARNING =
  'Apply creates or updates stacks only. Use `thonnas release --image-tag` to roll a new application image.';

// @intent Warn apply that --image-tag does not roll application images
export function applyImageTagWarning(imageTag?: string): string | undefined {
  if (imageTag && imageTag !== 'latest') {
    return APPLY_IMAGE_TAG_WARNING;
  }
  return undefined;
}



