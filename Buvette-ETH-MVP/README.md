# Buvette ETH

PWA mobile de portefeuille prépayé pour association. Le staff ajoute les adhérents, crédite en espèces/chèque et débite un produit d’un clic. L’administrateur gère produits et tarifs.

## Fonctions
- Saisie/recherche manuelle de l’adhérent et solde temps réel
- Grands boutons produits avec prix, débit immédiat
- Annulation visible 10 secondes (autorisée 10 minutes côté serveur)
- Crédit espèces ou chèque avec référence obligatoire
- Historique et traçabilité par utilisateur
- Protection contre double clic, requêtes répétées et débits simultanés
- Installation comme application sur Android/iPhone

## Mise en service gratuite
1. Créer un projet sur https://supabase.com.
2. Ouvrir **SQL Editor**, coller puis exécuter `supabase/schema.sql`.
3. Dans **Authentication > Users**, créer le premier utilisateur.
4. Copier son UUID et exécuter dans SQL Editor :
   `insert into public.profiles(id,display_name,role) values ('UUID','Votre nom','admin');`
5. Pour chaque compte staff, créer l’utilisateur puis son profil avec le rôle `staff`.
6. Copier `config.example.js` vers `config.js`, renseigner l’URL et la clé publique `anon` depuis **Project Settings > API**.
7. Déposer le dossier sur Cloudflare Pages, Netlify ou GitHub Pages. Aucun secret serveur n’est exposé : la clé anon est publique et les droits sont gérés par RLS.
8. Ouvrir l’URL sur le téléphone puis choisir **Ajouter à l’écran d’accueil**.

## Test local
Un serveur HTTP est requis (ouvrir directement `index.html` ne suffit pas) :
```bash
python -m http.server 8080 --directory buvette-eth
```
Puis ouvrir `http://localhost:8080`.

## Gestion des accès
Pour promouvoir un utilisateur :
```sql
update public.profiles set role='admin' where id='UUID_UTILISATEUR';
```

## Limites de l’offre gratuite
Le fonctionnement dépend d’Internet et des quotas/conditions de Supabase et de l’hébergeur. L’application ne remplace pas une comptabilité officielle. Prévoir exports et sauvegardes régulières avant un usage réel.
