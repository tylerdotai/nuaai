export interface LocalIntegrationSelection {
  matrix: boolean;
  search: boolean;
  browser: boolean;
  services: string[];
}

export function localIntegrationSelection(args: string[]): LocalIntegrationSelection;
