// Re-export both shadcn and roiui card components
// Original shadcn card (for backward compatibility)
export {
  Card,
  CardHeader,
  CardFooter,
  CardTitle,
  CardDescription,
  CardContent,
} from "./shadcn-card";

// Roiui card (newer, with variants and lift effect)
export {
  Card as RoiuiCard,
  CardAction as RoiuiCardAction,
  CardContent as RoiuiCardContent,
  CardDescription as RoiuiCardDescription,
  CardFooter as RoiuiCardFooter,
  CardHeader as RoiuiCardHeader,
  CardIcon as RoiuiCardIcon,
  CardImage as RoiuiCardImage,
  CardImageContent as RoiuiCardImageContent,
  CardTitle as RoiuiCardTitle,
} from "./roiui-card";
