{ pkgs, lib, config, inputs, ... }:

{
  packages = with pkgs; [
    bun
    git
    nodejs
  ];

  dotenv.disableHint = true;

  scripts.kit.exec = ''
    bun run kit/main.ts "$@"
  '';
}
