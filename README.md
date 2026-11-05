# Klocki i Las – aktualizacje i instalator

To repozytorium zawiera **tylko gotowe pliki gry** i podpisany plik `update.json` (kod źródłowy jest prywatny).

## Instalacja
Pobierz **KlockiLas-Setup.exe** z zakładki *Releases* (najnowsze wydanie) i uruchom. Instalator:
- nie wymaga praw administratora (instaluje w profilu użytkownika), tworzy skróty na pulpicie i w menu Start,
- uruchomiony ponownie na komputerze z grą – aktualizuje ją (zapisy graczy zostają),
- Windows może pokazać ostrzeżenie SmartScreen („nieznany wydawca”) – instalator nie ma płatnego certyfikatu firmy. Kliknij „Więcej informacji” → „Uruchom mimo to”.

Później wystarczy przycisk **Aktualizuj** w menu głównym gry.

## Bezpieczeństwo
Każda aktualizacja jest podpisana cyfrowo (Ed25519) kluczem, którego nie ma w tym repozytorium. Gra sprawdza podpis `update.json.sig`
i sumy SHA-256 plików; niepodpisane lub zmienione pliki są odrzucane.
